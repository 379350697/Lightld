import type { LiveOrderIntent } from './live-order-intent-schema.ts';

export type BuildOrderIntentInput = {
  strategyId: string;
  poolAddress: string;
  outputSol: number;
  executionPolicy?: 'broadcast' | 'simulate-only';
  createdAt?: string;
  side?: 'buy' | 'sell' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';
  tokenMint?: string;
  fullPositionExit?: boolean;
  liquidateResidualTokenToSol?: boolean;
  maxSlippageBps?: number;
  maxImpactBps?: number;
  inputAmountRaw?: string;
  preEntryTokenAmountRaw?: string;
  preEntryWalletSol?: number;
  preExitTokenAmountRaw?: string;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
};

export function buildOrderIntent(input: BuildOrderIntentInput): LiveOrderIntent {
  const createdAt = input.createdAt ?? new Date().toISOString();

  const intent = {
    strategyId: input.strategyId,
    poolAddress: input.poolAddress,
    outputSol: input.outputSol,
    createdAt,
    idempotencyKey: `${input.strategyId}:${input.poolAddress}:${createdAt}`,
    executionPolicy: input.executionPolicy ?? 'broadcast',
    side: input.side ?? 'buy',
    tokenMint: input.tokenMint ?? '',
    fullPositionExit: input.fullPositionExit ?? false,
    liquidateResidualTokenToSol: input.liquidateResidualTokenToSol ?? false
  };

  return {
    ...intent,
    ...(input.openIntentId ? { openIntentId: input.openIntentId } : {}),
    ...(input.positionId ? { positionId: input.positionId } : {}),
    ...(input.chainPositionAddress ? { chainPositionAddress: input.chainPositionAddress } : {}),
    ...(typeof input.maxSlippageBps === 'number' ? { maxSlippageBps: input.maxSlippageBps } : {}),
    ...(typeof input.maxImpactBps === 'number' ? { maxImpactBps: input.maxImpactBps } : {}),
    ...(input.inputAmountRaw ? { inputAmountRaw: input.inputAmountRaw } : {}),
    ...(typeof input.preEntryTokenAmountRaw === 'string'
      ? { preEntryTokenAmountRaw: input.preEntryTokenAmountRaw }
      : {}),
    ...(typeof input.preEntryWalletSol === 'number'
      ? { preEntryWalletSol: input.preEntryWalletSol }
      : {}),
    ...(typeof input.preExitTokenAmountRaw === 'string'
      ? { preExitTokenAmountRaw: input.preExitTokenAmountRaw }
      : {})
  };
}

