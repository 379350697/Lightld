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
  withdrawSolAmount?: number;
  withdrawTokenAmountLamports?: number;
  withdrawTokenAmountRaw?: string;
  withdrawTokenMint?: string;
  withdrawTokenValueSol?: number;
  liquidityValueSol?: number;
  unclaimedFeeSolAmount?: number;
  unclaimedFeeTokenAmountLamports?: number;
  unclaimedFeeTokenAmountRaw?: string;
  unclaimedFeeTokenMint?: string;
  unclaimedFeeTokenValueSol?: number;
  unclaimedFeeSol?: number;
  unclaimedFeeValueSol?: number;
  claimedFeeValueSol?: number;
  recoverableRentSol?: number;
  lpTotalValueSol?: number;
  valuationCompleteness?: 'complete' | 'incomplete' | 'untrusted';
  currentPrice?: number;
  lowerPrice?: number;
  upperPrice?: number;
  priceProgress?: number;
  positionStatus: 'active' | 'residual' | 'empty';
  hasLiquidity: boolean;
  hasClaimableFees: boolean;
  valuationStatus?: 'ready' | 'unavailable' | 'stale' | 'invalid';
  valuationReason?: string;
  valuationSource?: string;
};

export type MeteoraDirectSwapResult = {
  transaction: Transaction;
  outAmountLamports: string;
  minOutAmountLamports: string;
  consumedInAmountLamports: string;
  priceImpactPct?: number;
  provider: 'meteora-dlmm-direct';
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

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  if (value && typeof value === 'object' && 'toString' in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
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

  // Meteora pricePerToken is tokenY per tokenX in UI units.
  if (input.solSide === 'tokenX') {
    return tokenXAmount + (tokenYAmount / pricePerToken);
  }

  return tokenYAmount + (tokenXAmount * pricePerToken);
}

function computeWithdrawTokenValueSol(input: {
  solSide: 'tokenX' | 'tokenY';
  pricePerToken: number | undefined;
  withdrawTokenAmountRaw?: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
}) {
  if (
    typeof input.pricePerToken !== 'number' ||
    !Number.isFinite(input.pricePerToken) ||
    input.pricePerToken <= 0 ||
    !input.withdrawTokenAmountRaw
  ) {
    return undefined;
  }

  if (input.solSide === 'tokenX') {
    const tokenYAmount = toUiAmount(input.withdrawTokenAmountRaw, input.tokenYDecimals);
    const value = tokenYAmount / input.pricePerToken;
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  const tokenXAmount = toUiAmount(input.withdrawTokenAmountRaw, input.tokenXDecimals);
  const value = tokenXAmount * input.pricePerToken;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toRawAmountString(value: unknown) {
  if (typeof value === 'bigint') {
    return value >= 0n ? value.toString() : undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? String(Math.floor(value)) : undefined;
  }

  if (typeof value === 'string') {
    return /^\d+$/.test(value) ? value : undefined;
  }

  if (value && typeof value === 'object' && 'toString' in value) {
    const raw = String(value);
    return /^\d+$/.test(raw) ? raw : undefined;
  }

  return undefined;
}

async function getRecoverableRentSol(connection: Connection, address: PublicKey) {
  try {
    const lamports = await connection.getBalance(address, 'confirmed');
    return lamports > 0 ? lamports / LAMPORTS_PER_SOL : 0;
  } catch {
    return 0;
  }
}

function toPositiveRawAmountString(value: unknown) {
  const raw = toRawAmountString(value);
  if (!raw || BigInt(raw) <= 0n) {
    return undefined;
  }

  return raw;
}

function rawAmountToNumber(raw: string | undefined) {
  if (!raw) {
    return undefined;
  }

  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

async function simulateFullWithdrawAmounts(input: {
  dlmmPool: any;
  position: any;
  lowerBinId: number;
  upperBinId: number;
  solSide: 'tokenX' | 'tokenY';
  withdrawTokenMint: string;
}): Promise<Pick<
  MeteoraLpPositionSnapshot,
  'withdrawSolAmount' | 'withdrawTokenAmountLamports' | 'withdrawTokenAmountRaw' | 'withdrawTokenMint' | 'valuationStatus' | 'valuationReason' | 'valuationSource'
>> {
  try {
    const response = await input.dlmmPool.simulateRebalancePosition(
      input.position.publicKey,
      input.position.positionData,
      true,
      false,
      [],
      [{
        minBinId: new BN(input.lowerBinId),
        maxBinId: new BN(input.upperBinId),
        bps: new BN(10_000)
      }]
    );

    const result = response?.simulationResult ?? response;
    const actualXRaw = toRawAmountString(result?.actualAmountXWithdrawn);
    const actualYRaw = toRawAmountString(result?.actualAmountYWithdrawn);
    const withdrawSolRaw = input.solSide === 'tokenX' ? actualXRaw : actualYRaw;
    const withdrawTokenRaw = input.solSide === 'tokenX' ? actualYRaw : actualXRaw;
    const withdrawSolLamports = rawAmountToNumber(withdrawSolRaw);
    const withdrawSolAmount = typeof withdrawSolLamports === 'number'
      ? withdrawSolLamports / LAMPORTS_PER_SOL
      : undefined;
    const withdrawTokenAmountLamports = rawAmountToNumber(withdrawTokenRaw);

    if (typeof withdrawSolAmount !== 'number' || withdrawSolAmount < 0 || !withdrawTokenRaw) {
      return {
        valuationStatus: 'invalid',
        valuationReason: 'invalid-withdraw-simulation',
        valuationSource: 'meteora-withdraw-simulation'
      };
    }

    return {
      withdrawSolAmount,
      withdrawTokenAmountLamports,
      withdrawTokenAmountRaw: withdrawTokenRaw,
      withdrawTokenMint: input.withdrawTokenMint,
      valuationStatus: withdrawTokenRaw !== '0' ? 'unavailable' : 'ready',
      valuationReason: withdrawTokenRaw !== '0' ? 'withdraw-token-quote-required' : '',
      valuationSource: 'meteora-withdraw-simulation'
    };
  } catch (error) {
    return {
      valuationStatus: 'unavailable',
      valuationReason: `withdraw-simulation-failed:${readErrorMessage(error)}`,
      valuationSource: 'meteora-withdraw-simulation'
    };
  }
}

function resolveTokenDecimals(tokenReserve: unknown) {
  const decimals = (tokenReserve as { mint?: { decimals?: unknown } } | undefined)?.mint?.decimals;
  return typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0
    ? decimals
    : undefined;
}

function toPositiveFiniteNumber(value: unknown) {
  const numeric = toNumericValue(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function pricePerLamportToPricePerToken(pricePerLamport: number, tokenXDecimals: number, tokenYDecimals: number) {
  const price = pricePerLamport * (10 ** (tokenXDecimals - tokenYDecimals));
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

function pricePerTokenFromBinId(binId: number, binStep: number, tokenXDecimals: number, tokenYDecimals: number) {
  if (!Number.isFinite(binId) || !Number.isFinite(binStep)) {
    return undefined;
  }

  const getPriceOfBinByBinId = (dlmmPkg as { getPriceOfBinByBinId?: (binId: number, binStep: number) => unknown }).getPriceOfBinByBinId;
  if (typeof getPriceOfBinByBinId !== 'function') {
    return undefined;
  }

  const pricePerLamport = toPositiveFiniteNumber(getPriceOfBinByBinId(binId, binStep));
  if (typeof pricePerLamport !== 'number') {
    return undefined;
  }

  return pricePerLamportToPricePerToken(pricePerLamport, tokenXDecimals, tokenYDecimals);
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

  async swapTokenToSol(
    walletPublicKey: PublicKey,
    poolAddress: string,
    tokenMint: string,
    amountLamports: number | string | bigint,
    slippageBps = 100
  ): Promise<MeteoraDirectSwapResult> {
    const amountRaw = toPositiveRawAmountString(amountLamports);
    if (!amountRaw) {
      throw new Error('Meteora direct swap amount must be positive');
    }

    return this.withConnection(async (connection) => {
      const lbPair = new PublicKey(poolAddress);
      const inToken = new PublicKey(tokenMint);
      const dlmmPool = await DLMM.create(connection, lbPair);
      const tokenX = ((dlmmPool as any).tokenX?.publicKey ?? (dlmmPool as any).lbPair?.tokenXMint) as PublicKey | undefined;
      const tokenY = ((dlmmPool as any).tokenY?.publicKey ?? (dlmmPool as any).lbPair?.tokenYMint) as PublicKey | undefined;

      if (!tokenX || !tokenY) {
        throw new Error(`Meteora pool ${poolAddress} is missing token mints`);
      }

      const tokenXIsInput = tokenX.equals(inToken);
      const tokenYIsInput = tokenY.equals(inToken);
      const tokenXIsSol = tokenX.equals(SOL_MINT);
      const tokenYIsSol = tokenY.equals(SOL_MINT);

      if (!(tokenXIsInput || tokenYIsInput)) {
        throw new Error(`Token ${tokenMint} is not part of Meteora pool ${poolAddress}`);
      }

      if (!((tokenXIsInput && tokenYIsSol) || (tokenYIsInput && tokenXIsSol))) {
        throw new Error(`Meteora pool ${poolAddress} is not a ${tokenMint}/SOL pair`);
      }

      const swapForY = tokenXIsInput && tokenYIsSol;
      const allowedSlippage = new BN(Math.max(1, Math.floor(slippageBps)));
      const inAmount = new BN(amountRaw);
      const binArrays = await dlmmPool.getBinArrayForSwap(swapForY);
      const quote = dlmmPool.swapQuote(inAmount, swapForY, allowedSlippage, binArrays, false);

      if (isZeroLike(quote?.outAmount) || isZeroLike(quote?.minOutAmount)) {
        throw new Error(`Meteora direct swap returned zero SOL output for ${tokenMint}`);
      }

      const transaction = await dlmmPool.swap({
        inToken,
        outToken: SOL_MINT,
        inAmount,
        minOutAmount: quote.minOutAmount,
        lbPair,
        user: walletPublicKey,
        binArraysPubkey: quote.binArraysPubkey
      });
      const priceImpactPct = toFiniteNumber(quote?.priceImpact);

      return {
        transaction,
        outAmountLamports: String(quote.outAmount),
        minOutAmountLamports: String(quote.minOutAmount),
        consumedInAmountLamports: String(quote.consumedInAmount ?? amountRaw),
        priceImpactPct,
        provider: 'meteora-dlmm-direct'
      };
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
        const positionInfo = poolPositionInfo as PositionInfo;
        const userPositions = Array.isArray((positionInfo as any).lbPairPositionsData)
          ? (positionInfo as any).lbPairPositionsData
          : [];
        if (!userPositions.length) {
          continue;
        }

        const tokenXPublicKey = (positionInfo as any).tokenX?.publicKey as PublicKey | undefined;
        const tokenYPublicKey = (positionInfo as any).tokenY?.publicKey as PublicKey | undefined;
        const tokenXMint = tokenXPublicKey?.toBase58?.() ?? '';
        const tokenYMint = tokenYPublicKey?.toBase58?.() ?? '';
        const tokenXIsSol = tokenXPublicKey?.equals?.(SOL_MINT) ?? tokenXMint === SOL_MINT.toBase58();
        const tokenYIsSol = tokenYPublicKey?.equals?.(SOL_MINT) ?? tokenYMint === SOL_MINT.toBase58();
        if (!tokenXIsSol && !tokenYIsSol) {
          continue;
        }

        const mint = tokenXIsSol ? tokenYMint : tokenXMint;
        const solSide = tokenXIsSol ? 'tokenX' as const : 'tokenY' as const;
        const activeBinIdValue = toFiniteNumber((positionInfo as any).lbPair?.activeId);
        const activeBinId = activeBinIdValue ?? 0;
        const tokenXDecimals = resolveTokenDecimals(positionInfo.tokenX);
        const tokenYDecimals = resolveTokenDecimals(positionInfo.tokenY);
        const binStep = toPositiveFiniteNumber((positionInfo as any).lbPair?.binStep);
        const currentPrice = typeof tokenXDecimals === 'number' && typeof tokenYDecimals === 'number' && typeof activeBinIdValue === 'number' && typeof binStep === 'number'
          ? pricePerTokenFromBinId(activeBinIdValue, binStep, tokenXDecimals, tokenYDecimals)
          : undefined;
        let dlmmPoolForValuation: any | undefined;
        let dlmmPoolValuationReason: string | undefined;
        try {
          dlmmPoolForValuation = await DLMM.create(connection, new PublicKey(poolAddress));
        } catch (error) {
          dlmmPoolValuationReason = `withdraw-simulation-pool-load-failed:${readErrorMessage(error)}`;
        }

        for (const position of userPositions) {
          const summary = summarizePosition(position);
          const hasPrice = typeof tokenXDecimals === 'number'
            && typeof tokenYDecimals === 'number'
            && typeof currentPrice === 'number';
          const withdrawSimulation = dlmmPoolForValuation
            ? await simulateFullWithdrawAmounts({
              dlmmPool: dlmmPoolForValuation,
              position,
              lowerBinId: summary.lowerBinId,
              upperBinId: summary.upperBinId,
              solSide,
              withdrawTokenMint: mint
            })
            : {
              valuationStatus: 'unavailable' as const,
              valuationReason: dlmmPoolValuationReason ?? 'withdraw-simulation-unavailable',
              valuationSource: 'meteora-withdraw-simulation'
            };
          const withdrawTokenValueSol = hasPrice && withdrawSimulation.withdrawTokenAmountRaw !== '0'
            ? computeWithdrawTokenValueSol({
              solSide,
              pricePerToken: currentPrice,
              withdrawTokenAmountRaw: withdrawSimulation.withdrawTokenAmountRaw,
              tokenXDecimals,
              tokenYDecimals
            })
            : undefined;
          const liquidityValueSol = typeof withdrawSimulation.withdrawSolAmount === 'number'
            ? withdrawSimulation.withdrawTokenAmountRaw === '0'
              ? withdrawSimulation.withdrawSolAmount
              : typeof withdrawTokenValueSol === 'number'
                ? withdrawSimulation.withdrawSolAmount + withdrawTokenValueSol
                : undefined
            : undefined;
          const feeXRaw = toRawAmountString((position.positionData as any).feeXExcludeTransferFee ?? (position.positionData as any).feeX) ?? '0';
          const feeYRaw = toRawAmountString((position.positionData as any).feeYExcludeTransferFee ?? (position.positionData as any).feeY) ?? '0';
          const unclaimedFeeSolRaw = solSide === 'tokenX' ? feeXRaw : feeYRaw;
          const unclaimedFeeTokenRaw = solSide === 'tokenX' ? feeYRaw : feeXRaw;
          const unclaimedFeeSolLamports = rawAmountToNumber(unclaimedFeeSolRaw);
          const unclaimedFeeSolAmount = typeof unclaimedFeeSolLamports === 'number'
            ? unclaimedFeeSolLamports / LAMPORTS_PER_SOL
            : undefined;
          const unclaimedFeeTokenAmountLamports = rawAmountToNumber(unclaimedFeeTokenRaw);
          const unclaimedFeeTokenValueSol = hasPrice && unclaimedFeeTokenRaw !== '0'
            ? computeWithdrawTokenValueSol({
              solSide,
              pricePerToken: currentPrice,
              withdrawTokenAmountRaw: unclaimedFeeTokenRaw,
              tokenXDecimals,
              tokenYDecimals
            })
            : undefined;
          const unclaimedFeeSol = hasPrice
            ? computeSolValueFromPairAmounts({
              solSide,
              pricePerToken: currentPrice,
              tokenXAmountRaw: feeXRaw,
              tokenYAmountRaw: feeYRaw,
              tokenXDecimals,
              tokenYDecimals
            })
            : undefined;
          const unclaimedFeeValueSol = typeof unclaimedFeeSolAmount === 'number'
            ? unclaimedFeeTokenRaw === '0'
              ? unclaimedFeeSolAmount
              : typeof unclaimedFeeTokenValueSol === 'number'
                ? unclaimedFeeSolAmount + unclaimedFeeTokenValueSol
                : undefined
            : undefined;
          const recoverableRentSol = await getRecoverableRentSol(connection, position.publicKey);
          const hasWithdrawToken = withdrawSimulation.withdrawTokenAmountRaw !== undefined
            && withdrawSimulation.withdrawTokenAmountRaw !== '0';
          const hasFeeToken = unclaimedFeeTokenRaw !== undefined && unclaimedFeeTokenRaw !== '0';
          const requiresTokenQuote = hasWithdrawToken || hasFeeToken;
          const lpTotalValueSol = typeof liquidityValueSol === 'number' && typeof unclaimedFeeValueSol === 'number'
            ? liquidityValueSol + unclaimedFeeValueSol + recoverableRentSol
            : undefined;
          const currentValueSol = lpTotalValueSol;
          const rentSourceSuffix = recoverableRentSol > 0 ? '+position-account-rent' : '';
          const valuationCompleteness = typeof lpTotalValueSol === 'number'
            ? (requiresTokenQuote ? 'untrusted' as const : 'complete' as const)
            : 'incomplete' as const;
          const valuationStatus = valuationCompleteness === 'complete'
            ? 'ready' as const
            : valuationCompleteness === 'untrusted'
              ? 'stale' as const
              : withdrawSimulation.valuationStatus;
          const valuationReason = valuationCompleteness === 'complete'
            ? ''
            : valuationCompleteness === 'untrusted'
              ? 'swap-provider-quote-required'
              : withdrawSimulation.valuationReason;
          const valuationSource = valuationCompleteness === 'complete'
            ? withdrawSimulation.valuationSource + rentSourceSuffix
            : valuationCompleteness === 'untrusted'
              ? `${withdrawSimulation.valuationSource}+dlmm-active-bin-price-fallback${rentSourceSuffix}`
              : withdrawSimulation.valuationSource;
          const lowerPrice = typeof tokenXDecimals === 'number' && typeof tokenYDecimals === 'number' && typeof binStep === 'number'
            ? pricePerTokenFromBinId(summary.lowerBinId, binStep, tokenXDecimals, tokenYDecimals)
            : undefined;
          const upperPrice = typeof tokenXDecimals === 'number' && typeof tokenYDecimals === 'number' && typeof binStep === 'number'
            ? pricePerTokenFromBinId(summary.upperBinId, binStep, tokenXDecimals, tokenYDecimals)
            : undefined;

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
            withdrawSolAmount: withdrawSimulation.withdrawSolAmount,
            withdrawTokenAmountLamports: withdrawSimulation.withdrawTokenAmountLamports,
            withdrawTokenAmountRaw: withdrawSimulation.withdrawTokenAmountRaw,
            withdrawTokenMint: withdrawSimulation.withdrawTokenMint,
            withdrawTokenValueSol,
            liquidityValueSol,
            unclaimedFeeSolAmount,
            unclaimedFeeTokenAmountLamports,
            unclaimedFeeTokenAmountRaw: unclaimedFeeTokenRaw,
            unclaimedFeeTokenMint: mint,
            unclaimedFeeTokenValueSol,
            unclaimedFeeSol,
            unclaimedFeeValueSol,
            claimedFeeValueSol: 0,
            recoverableRentSol,
            lpTotalValueSol,
            valuationCompleteness,
            currentPrice,
            lowerPrice,
            upperPrice,
            priceProgress: computePriceProgress(currentPrice, lowerPrice, upperPrice),
            positionStatus: summary.positionStatus,
            hasLiquidity: summary.hasLiquidity,
            hasClaimableFees: summary.hasClaimableFees,
            valuationStatus,
            valuationReason,
            valuationSource
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
