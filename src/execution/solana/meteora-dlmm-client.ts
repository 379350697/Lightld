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
    
    const positionsByPool = await DLMM.getAllLbPairPositionsByUser(this.connection, walletPublicKey);
    const poolPositions = positionsByPool.get(poolAddress);
    if (!poolPositions || poolPositions.lbPairPositionsData.length === 0) {
      throw new Error('Position not found for pool');
    }

    const positionInfo = poolPositions.lbPairPositionsData[0];
    const positionPubKey = positionInfo.publicKey;

    const removeLiquidityIxs = await dlmmPool.removeLiquidity({
      user: walletPublicKey,
      position: positionPubKey,
      fromBinId: positionInfo.positionData.lowerBinId,
      toBinId: positionInfo.positionData.upperBinId,
      bps: new BN(10000), // 100%
      shouldClaimAndClose: true,
      skipUnwrapSOL: false,
    });
    
    return removeLiquidityIxs;
  }

  async claimFee(walletPublicKey: PublicKey, poolAddress: string) {
    const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));

    const positionsByPool = await DLMM.getAllLbPairPositionsByUser(this.connection, walletPublicKey);
    const poolPositions = positionsByPool.get(poolAddress);
    if (!poolPositions || poolPositions.lbPairPositionsData.length === 0) {
      throw new Error('Position not found for pool');
    }
    const positionInfo = poolPositions.lbPairPositionsData[0];
    const positionPubKey = positionInfo.publicKey;

    return await dlmmPool.removeLiquidity({
      user: walletPublicKey,
      position: positionPubKey,
      fromBinId: positionInfo.positionData.lowerBinId,
      toBinId: positionInfo.positionData.upperBinId,
      bps: new BN(0), // 0% means just claim fee and keep liquidity
      shouldClaimAndClose: false,
      skipUnwrapSOL: false,
    });
  }

  async getPositions(walletPublicKey: PublicKey): Promise<Map<string, PositionInfo>> {
    return DLMM.getAllLbPairPositionsByUser(this.connection, walletPublicKey);
  }
}
