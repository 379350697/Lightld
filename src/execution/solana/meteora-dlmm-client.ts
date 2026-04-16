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

import { LAMPORTS_PER_SOL } from './jupiter-client.ts';

export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export type MeteoraLpPositionSnapshot = {
  poolAddress: string;
  positionAddress: string;
  mint: string;
};

function flattenTransactions<T>(transactions: Array<T | T[]>) {
  return transactions.flatMap((transaction) => Array.isArray(transaction) ? transaction : [transaction]);
}

export class MeteoraDlmmClient {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async addLiquidityByStrategy(
    walletPublicKey: PublicKey,
    poolAddress: string,
    amountSol: number,
    strategyType: any = StrategyType.BidAsk
  ): Promise<{ transaction: Transaction | Transaction[]; newPositionKeypair: Keypair }> {
    const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
    const activeBin = await dlmmPool.getActiveBin();
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletPublicKey);

    if (userPositions.length > 0) {
      throw new Error(`Existing Meteora position already present for pool ${poolAddress}; refusing to initialize a duplicate position`);
    }

    const TOTAL_BINS = 69;
    const minBinId = activeBin.binId - Math.floor(TOTAL_BINS / 2);
    const maxBinId = activeBin.binId + Math.floor(TOTAL_BINS / 2);

    const amountInLamports = amountSol * LAMPORTS_PER_SOL;
    
    const isTokenXSol = dlmmPool.tokenX.publicKey.equals(SOL_MINT);
    
    const inAmountX = isTokenXSol ? new BN(amountInLamports) : new BN(0);
    const inAmountY = !isTokenXSol ? new BN(amountInLamports) : new BN(0);

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
      },
      slippage: 1, // 1%
    });

    return {
      transaction: result,
      newPositionKeypair: positionKeypair
    };
  }

  async removeLiquidity(walletPublicKey: PublicKey, poolAddress: string) {
    const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
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
  }

  async claimFee(walletPublicKey: PublicKey, poolAddress: string) {
    const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletPublicKey);

    if (userPositions.length === 0) {
      throw new Error('Position not found for pool');
    }

    return flattenTransactions(await dlmmPool.claimAllSwapFee({
      owner: walletPublicKey,
      positions: userPositions
    }));
  }

  async getPositions(walletPublicKey: PublicKey): Promise<Map<string, PositionInfo>> {
    return DLMM.getAllLbPairPositionsByUser(this.connection, walletPublicKey);
  }

  async getPositionSnapshots(walletPublicKey: PublicKey): Promise<MeteoraLpPositionSnapshot[]> {
    const positionsByPool = await DLMM.getAllLbPairPositionsByUser(this.connection, walletPublicKey);
    const snapshots: MeteoraLpPositionSnapshot[] = [];

    for (const [poolAddress, poolPositions] of positionsByPool.entries()) {
      const lbPairPositionsData = (poolPositions as { lbPairPositionsData?: Array<{ publicKey: PublicKey }> } | undefined)?.lbPairPositionsData;
      if (!lbPairPositionsData || lbPairPositionsData.length === 0) {
        continue;
      }

      const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
      const tokenXMint = dlmmPool.tokenX.publicKey.toBase58();
      const tokenYMint = dlmmPool.tokenY.publicKey.toBase58();
      const mint = tokenXMint === SOL_MINT.toBase58() ? tokenYMint : tokenXMint;

      for (const positionInfo of lbPairPositionsData) {
        snapshots.push({
          poolAddress,
          positionAddress: positionInfo.publicKey.toBase58(),
          mint
        });
      }
    }

    return snapshots;
  }
}
