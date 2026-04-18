import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
// import DLMM, { StrategyType, PositionInfo } from '@meteora-ag/dlmm'; // Broken ESM dir imports
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dlmmPkg = require('@meteora-ag/dlmm');
const DLMM = dlmmPkg;
const { StrategyType } = dlmmPkg;

// PositionInfo is a type, so it's not present at runtime
// We'll import it just for type usage if needed, or use any
import type { PositionInfo } from '@meteora-ag/dlmm';

import BN from 'bn.js';
import {
  classifyRetryableRpcError,
  type RpcEndpointRegistry
} from '../rpc-endpoint-registry.ts';

import { LAMPORTS_PER_SOL } from './jupiter-client.ts';

export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export type MeteoraLpPositionSnapshot = {
  poolAddress: string;
  positionAddress: string;
  mint: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  binCount: number;
  fundedBinCount: number;
  solSide: 'tokenX' | 'tokenY';
  solDepletedBins: number;
  currentValueSol?: number;
  unclaimedFeeSol?: number;
  currentPrice?: number;
  lowerPrice?: number;
  upperPrice?: number;
  priceProgress?: number;
  positionStatus: 'active' | 'residual' | 'empty';
  hasLiquidity: boolean;
  hasClaimableFees: boolean;
};

const TARGET_SINGLE_SIDED_BIN_COUNT = 69;

function flattenTransactions<T>(transactions: Array<T | T[]>) {
  return transactions.flatMap((transaction) => Array.isArray(transaction) ? transaction : [transaction]);
}

function toNumericValue(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (value && typeof value === 'object' && 'toString' in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function isZeroLike(value: unknown) {
  if (value && typeof value === 'object' && 'isZero' in value && typeof (value as { isZero: () => boolean }).isZero === 'function') {
    return (value as { isZero: () => boolean }).isZero();
  }

  return toNumericValue(value) === 0;
}

function summarizePosition(positionInfo: any) {
  const positionData = positionInfo?.positionData ?? {};
  const lowerBinId = Number(positionData.lowerBinId ?? 0);
  const upperBinId = Number(positionData.upperBinId ?? lowerBinId);
  const positionBinData = Array.isArray(positionData.positionBinData) ? positionData.positionBinData : [];
  const fundedBinCount = positionBinData.filter((bin: any) =>
    toNumericValue(bin?.positionXAmount) > 0 ||
    toNumericValue(bin?.positionYAmount) > 0 ||
    toNumericValue(bin?.positionLiquidityShare) > 0
  ).length;

  const hasClaimableFees =
    !isZeroLike(positionData.feeX) ||
    !isZeroLike(positionData.feeY) ||
    positionBinData.some((bin: any) =>
      toNumericValue(bin?.positionFeeXAmount) > 0 || toNumericValue(bin?.positionFeeYAmount) > 0
    );

  const hasResidualValue =
    toNumericValue(positionData.totalXAmountExcludeTransferFee ?? positionData.totalXAmount) > 0 ||
    toNumericValue(positionData.totalYAmountExcludeTransferFee ?? positionData.totalYAmount) > 0;

  const positionStatus: MeteoraLpPositionSnapshot['positionStatus'] = fundedBinCount > 0
    ? 'active'
    : (hasClaimableFees || hasResidualValue ? 'residual' : 'empty');

  return {
    lowerBinId,
    upperBinId,
    binCount: Math.max(0, upperBinId - lowerBinId + 1),
    fundedBinCount,
    positionStatus,
    hasLiquidity: fundedBinCount > 0,
    hasClaimableFees
  };
}

function resolveSingleSidedBinRange(activeBinId: number, singleSidedX: boolean) {
  const width = TARGET_SINGLE_SIDED_BIN_COUNT - 1;
  return singleSidedX
    ? { minBinId: activeBinId, maxBinId: activeBinId + width }
    : { minBinId: activeBinId - width, maxBinId: activeBinId };
}

function computeSolDepletedBins(input: {
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  solSide: 'tokenX' | 'tokenY';
}) {
  if (input.solSide === 'tokenX') {
    return Math.max(0, input.activeBinId - input.lowerBinId);
  }

  return Math.max(0, input.upperBinId - input.activeBinId);
}

function toUiAmount(rawAmount: unknown, decimals: number) {
  const numeric = toNumericValue(rawAmount);
  if (!Number.isFinite(numeric) || decimals < 0) {
    return 0;
  }

  return numeric / (10 ** decimals);
}

function computeSolValueFromPairAmounts(input: {
  solSide: 'tokenX' | 'tokenY';
  pricePerToken: number;
  tokenXAmountRaw: unknown;
  tokenYAmountRaw: unknown;
  tokenXDecimals: number;
  tokenYDecimals: number;
}) {
  const tokenXAmount = toUiAmount(input.tokenXAmountRaw, input.tokenXDecimals);
  const tokenYAmount = toUiAmount(input.tokenYAmountRaw, input.tokenYDecimals);
  const pricePerToken = input.pricePerToken;

  if (!Number.isFinite(pricePerToken) || pricePerToken <= 0) {
    return input.solSide === 'tokenX' ? tokenXAmount : tokenYAmount;
  }

  if (input.solSide === 'tokenX') {
    return tokenXAmount + (tokenYAmount / pricePerToken);
  }

  return tokenYAmount + (tokenXAmount * pricePerToken);
}

function resolveTokenDecimals(tokenReserve: unknown) {
  const decimals = (tokenReserve as { mint?: { decimals?: unknown } } | undefined)?.mint?.decimals;
  return typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0
    ? decimals
    : undefined;
}

function priceFromBinId(binId: number, binStep: number, tokenXDecimals: number, tokenYDecimals: number) {
  if (!Number.isFinite(binId) || !Number.isFinite(binStep)) {
    return undefined;
  }

  const base = 1 + (binStep / 10_000);
  const decimalFactor = 10 ** (tokenYDecimals - tokenXDecimals);
  const price = (base ** binId) * decimalFactor;
  return Number.isFinite(price) ? price : undefined;
}

function computePriceProgress(currentPrice: number | undefined, lowerPrice: number | undefined, upperPrice: number | undefined) {
  if (
    typeof currentPrice !== 'number' ||
    typeof lowerPrice !== 'number' ||
    typeof upperPrice !== 'number' ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(lowerPrice) ||
    !Number.isFinite(upperPrice) ||
    upperPrice <= lowerPrice
  ) {
    return undefined;
  }

  return Math.max(0, Math.min(1, (currentPrice - lowerPrice) / (upperPrice - lowerPrice)));
}

export class MeteoraDlmmClient {
  private readonly connections: Connection[];
  private readonly connectionIds: string[];
  private readonly connectionsById: Map<string, Connection>;
  private readonly endpointRegistry?: RpcEndpointRegistry;
  private readonly positionSnapshotTtlMs: number;
  private readonly nowMs: () => number;
  private readonly positionSnapshotCache = new Map<string, {
    expiresAt: number;
    snapshots: MeteoraLpPositionSnapshot[];
  }>();
  private readonly positionSnapshotInflight = new Map<string, Promise<MeteoraLpPositionSnapshot[]>>();

  constructor(
    connection: Connection | Connection[],
    options: {
      endpointRegistry?: RpcEndpointRegistry;
      positionSnapshotTtlMs?: number;
      nowMs?: () => number;
    } = {}
  ) {
    this.connections = Array.isArray(connection) ? connection : [connection];
    this.connectionIds = this.connections.map((item, index) => this.resolveConnectionId(item, index));
    this.connectionsById = new Map(this.connections.map((item, index) => [this.connectionIds[index], item]));
    this.endpointRegistry = options.endpointRegistry;
    this.positionSnapshotTtlMs = Math.max(0, options.positionSnapshotTtlMs ?? 15_000);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  private async withConnection<T>(
    operation: (connection: Connection) => Promise<T>
  ): Promise<T> {
    const registry = this.endpointRegistry;
    if (!registry) {
      let lastError: Error | undefined;

      for (const connection of this.connections) {
        try {
          return await operation(connection);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (!classifyRetryableRpcError(lastError)) {
            throw lastError;
          }
        }
      }

      throw lastError ?? new Error('No DLMM RPC connections configured');
    }

    return registry.runWithEndpoint({
      kind: 'dlmm',
      candidates: this.connectionIds,
      execute: (connectionId) => operation(this.connectionsById.get(connectionId)!),
      classifyError: (error) => classifyRetryableRpcError(error)
    });
  }

  private resolveConnectionId(connection: Connection, index: number) {
    const rpcEndpoint = (connection as Connection & { rpcEndpoint?: string }).rpcEndpoint;
    if (typeof rpcEndpoint === 'string' && rpcEndpoint.length > 0) {
      return rpcEndpoint;
    }

    const label = (connection as Connection & { label?: string }).label;
    if (typeof label === 'string' && label.length > 0) {
      return label;
    }

    return `dlmm-connection-${index}`;
  }

  private getPositionSnapshotCacheKey(walletPublicKey: PublicKey) {
    return walletPublicKey.toBase58();
  }

  invalidatePositionSnapshots(walletPublicKey: PublicKey) {
    const cacheKey = this.getPositionSnapshotCacheKey(walletPublicKey);
    this.positionSnapshotCache.delete(cacheKey);
    this.positionSnapshotInflight.delete(cacheKey);
  }

  async warmPositionSnapshots(walletPublicKey: PublicKey) {
    await this.getPositionSnapshots(walletPublicKey);
  }

  async addLiquidityByStrategy(
    walletPublicKey: PublicKey,
    poolAddress: string,
    amountSol: number,
    strategyType: any = StrategyType.BidAsk
  ): Promise<{ transaction: Transaction | Transaction[]; newPositionKeypair?: Keypair }> {
    return this.withConnection(async (connection) => {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
      const activeBin = await dlmmPool.getActiveBin();
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletPublicKey);
      const isTokenXSol = dlmmPool.tokenX.publicKey.equals(SOL_MINT);
      const { minBinId, maxBinId } = resolveSingleSidedBinRange(activeBin.binId, isTokenXSol);
      const amountInLamports = amountSol * LAMPORTS_PER_SOL;
      const inAmountX = isTokenXSol ? new BN(amountInLamports) : new BN(0);
      const inAmountY = !isTokenXSol ? new BN(amountInLamports) : new BN(0);

      const repairCandidate = userPositions.find((positionInfo: any) =>
        Number(positionInfo?.positionData?.lowerBinId ?? Number.NaN) === minBinId &&
        Number(positionInfo?.positionData?.upperBinId ?? Number.NaN) === maxBinId
      );

      if (repairCandidate) {
        return {
          newPositionKeypair: undefined,
          transaction: await dlmmPool.addLiquidityByStrategy({
            positionPubKey: repairCandidate.publicKey,
            user: walletPublicKey,
            totalXAmount: inAmountX,
            totalYAmount: inAmountY,
            strategy: {
              maxBinId,
              minBinId,
              strategyType,
              singleSidedX: isTokenXSol
            },
            slippage: 1
          })
        };
      }

      if (userPositions.length > 0) {
        throw new Error(`Existing Meteora positions already present for pool ${poolAddress}; refusing to initialize a duplicate position without a matching repair target`);
      }

      const positionKeypair = Keypair.generate();
      const result = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: walletPublicKey,
        totalXAmount: inAmountX,
        totalYAmount: inAmountY,
        strategy: {
          maxBinId,
          minBinId,
          strategyType,
          singleSidedX: isTokenXSol,
        },
        slippage: 1, // 1%
      });

      return {
        transaction: result,
        newPositionKeypair: positionKeypair
      };
    });
  }

  async removeLiquidity(walletPublicKey: PublicKey, poolAddress: string) {
    return this.withConnection(async (connection) => {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletPublicKey);

      if (userPositions.length === 0) {
        throw new Error('Position not found for pool');
      }

      const transactions = await Promise.all(
        userPositions.map((positionInfo: any) => dlmmPool.removeLiquidity({
          user: walletPublicKey,
          position: positionInfo.publicKey,
          fromBinId: positionInfo.positionData.lowerBinId,
          toBinId: positionInfo.positionData.upperBinId,
          bps: new BN(10000), // 100%
          shouldClaimAndClose: true,
          skipUnwrapSOL: false,
        }))
      );

      return flattenTransactions(transactions);
    });
  }

  async claimFee(walletPublicKey: PublicKey, poolAddress: string) {
    return this.withConnection(async (connection) => {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletPublicKey);

      if (userPositions.length === 0) {
        throw new Error('Position not found for pool');
      }

      return flattenTransactions(await dlmmPool.claimAllSwapFee({
        owner: walletPublicKey,
        positions: userPositions
      }));
    });
  }

  async getPositions(walletPublicKey: PublicKey): Promise<Map<string, PositionInfo>> {
    return this.withConnection((connection) => DLMM.getAllLbPairPositionsByUser(connection, walletPublicKey));
  }

  async getPositionSnapshots(walletPublicKey: PublicKey): Promise<MeteoraLpPositionSnapshot[]> {
    const cacheKey = this.getPositionSnapshotCacheKey(walletPublicKey);
    const now = this.nowMs();
    const cached = this.positionSnapshotCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.snapshots;
    }

    const inflight = this.positionSnapshotInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const loadSnapshots = this.withConnection(async (connection) => {
      const positionsByPool = await DLMM.getAllLbPairPositionsByUser(connection, walletPublicKey);
      const snapshots: MeteoraLpPositionSnapshot[] = [];

      for (const [poolAddress, poolPositionInfo] of positionsByPool.entries()) {
        const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
        const { activeBin, userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletPublicKey);
        if (!userPositions?.length) {
          continue;
        }
        const tokenXMint = dlmmPool.tokenX.publicKey.toBase58();
        const tokenYMint = dlmmPool.tokenY.publicKey.toBase58();
        const mint = tokenXMint === SOL_MINT.toBase58() ? tokenYMint : tokenXMint;
        const solSide = tokenXMint === SOL_MINT.toBase58() ? 'tokenX' as const : 'tokenY' as const;
        const activeBinId = Number(activeBin?.binId ?? 0);
        const activePricePerToken = Number(activeBin?.pricePerToken ?? activeBin?.price ?? 0);
        const tokenXDecimals = resolveTokenDecimals((poolPositionInfo as PositionInfo | undefined)?.tokenX);
        const tokenYDecimals = resolveTokenDecimals((poolPositionInfo as PositionInfo | undefined)?.tokenY);
        const binStep = Number((dlmmPool.lbPair as { binStep?: { toString?: () => string } } | undefined)?.binStep?.toString?.() ?? 0);

        for (const position of userPositions) {
          const summary = summarizePosition(position);
          const currentValueSol = typeof tokenXDecimals === 'number' && typeof tokenYDecimals === 'number'
            ? computeSolValueFromPairAmounts({
              solSide,
              pricePerToken: activePricePerToken,
              tokenXAmountRaw: (position.positionData as any).totalXAmountExcludeTransferFee ?? (position.positionData as any).totalXAmount,
              tokenYAmountRaw: (position.positionData as any).totalYAmountExcludeTransferFee ?? (position.positionData as any).totalYAmount,
              tokenXDecimals,
              tokenYDecimals
            })
            : undefined;
          const unclaimedFeeSol = typeof tokenXDecimals === 'number' && typeof tokenYDecimals === 'number'
            ? computeSolValueFromPairAmounts({
              solSide,
              pricePerToken: activePricePerToken,
              tokenXAmountRaw: (position.positionData as any).feeXExcludeTransferFee ?? (position.positionData as any).feeX,
              tokenYAmountRaw: (position.positionData as any).feeYExcludeTransferFee ?? (position.positionData as any).feeY,
              tokenXDecimals,
              tokenYDecimals
            })
            : undefined;
          const lowerPrice = typeof tokenXDecimals === 'number' && typeof tokenYDecimals === 'number'
            ? priceFromBinId(summary.lowerBinId, binStep, tokenXDecimals, tokenYDecimals)
            : undefined;
          const upperPrice = typeof tokenXDecimals === 'number' && typeof tokenYDecimals === 'number'
            ? priceFromBinId(summary.upperBinId, binStep, tokenXDecimals, tokenYDecimals)
            : undefined;
          const currentPrice = typeof tokenXDecimals === 'number' && typeof tokenYDecimals === 'number'
            ? priceFromBinId(activeBinId, binStep, tokenXDecimals, tokenYDecimals)
            : (Number.isFinite(activePricePerToken) && activePricePerToken > 0 ? activePricePerToken : undefined);

          snapshots.push({
            poolAddress,
            positionAddress: position.publicKey.toBase58(),
            mint,
            lowerBinId: summary.lowerBinId,
            upperBinId: summary.upperBinId,
            activeBinId,
            binCount: summary.binCount,
            fundedBinCount: summary.fundedBinCount,
            solSide,
            solDepletedBins: computeSolDepletedBins({
              lowerBinId: summary.lowerBinId,
              upperBinId: summary.upperBinId,
              activeBinId,
              solSide
            }),
            currentValueSol,
            unclaimedFeeSol,
            currentPrice,
            lowerPrice,
            upperPrice,
            priceProgress: computePriceProgress(currentPrice, lowerPrice, upperPrice),
            positionStatus: summary.positionStatus,
            hasLiquidity: summary.hasLiquidity,
            hasClaimableFees: summary.hasClaimableFees
          });
        }
      }

      return snapshots;
    });

    const guardedLoad = loadSnapshots
      .then((snapshots) => {
        this.positionSnapshotCache.set(cacheKey, {
          expiresAt: this.nowMs() + this.positionSnapshotTtlMs,
          snapshots
        });
        return snapshots;
      })
      .catch((error) => {
        if (cached) {
          this.positionSnapshotCache.set(cacheKey, {
            expiresAt: this.nowMs() + this.positionSnapshotTtlMs,
            snapshots: cached.snapshots
          });
          return cached.snapshots;
        }

        throw error;
      })
      .finally(() => {
        this.positionSnapshotInflight.delete(cacheKey);
      });

    this.positionSnapshotInflight.set(cacheKey, guardedLoad);
    return guardedLoad;
  }
}
