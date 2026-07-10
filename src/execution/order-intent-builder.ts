import {
  LiveOrderIntentV2Schema,
  type LiveOrderIntent,
  type LiveOrderIntentV2
} from './live-order-intent-schema.ts';

export type OrderSide = 'buy' | 'sell' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';

export type BuildOrderIntentInput = {
  strategyId: string;
  poolAddress: string;
  outputSol: number;
  createdAt?: string;
  side?: OrderSide;
  tokenMint?: string;
  fullPositionExit?: boolean;
  liquidateResidualTokenToSol?: boolean;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
};

/** @deprecated V1 intents are for mechanical-soak compatibility only. */
export function buildOrderIntent(input: BuildOrderIntentInput): LiveOrderIntent {
  const createdAt = input.createdAt ?? new Date().toISOString();

  const intent = {
    strategyId: input.strategyId,
    poolAddress: input.poolAddress,
    outputSol: input.outputSol,
    createdAt,
    idempotencyKey: `${input.strategyId}:${input.poolAddress}:${createdAt}`,
    side: input.side ?? 'buy',
    tokenMint: input.tokenMint ?? '',
    fullPositionExit: input.fullPositionExit ?? false,
    liquidateResidualTokenToSol: input.liquidateResidualTokenToSol ?? false
  };

  return {
    ...intent,
    ...(input.openIntentId ? { openIntentId: input.openIntentId } : {}),
    ...(input.positionId ? { positionId: input.positionId } : {}),
    ...(input.chainPositionAddress ? { chainPositionAddress: input.chainPositionAddress } : {})
  };
}

export type BuildOrderIntentV2Input = {
  strategyId: string;
  poolAddress: string;
  tokenMint: string;
  outputSol: number;
  side: OrderSide;
  createdAt?: string;
  idempotencyKey?: string;
  fullPositionExit?: boolean;
  liquidateResidualTokenToSol?: boolean;
  runId: string;
  lifecycleKey: string;
  openIntentId: string;
  positionId?: string;
  chainPositionAddress?: string;
  configSnapshotId: string;
  riskSnapshotId: string;
  maxInputSol?: number;
  minOutputSol?: number;
  maxSlippageBps: number;
  maxImpactBps: number;
  quotedImpactBps: number;
  maxTotalFeeLamports: number;
  estimatedTotalFeeLamports: number;
  quoteHash: string;
  quoteSlot: number;
  quoteCreatedAt: string;
  candidateObservedAt?: string;
  expiresAt: string;
  lastValidBlockHeight: number;
};

export function buildOrderIntentV2(input: BuildOrderIntentV2Input): LiveOrderIntentV2 {
  const createdAt = input.createdAt ?? new Date().toISOString();

  return LiveOrderIntentV2Schema.parse({
    schemaVersion: 2,
    strategyId: input.strategyId,
    poolAddress: input.poolAddress,
    tokenMint: input.tokenMint,
    outputSol: input.outputSol,
    createdAt,
    idempotencyKey: input.idempotencyKey ?? `${input.runId}:${input.lifecycleKey}:${input.side}`,
    side: input.side,
    fullPositionExit: input.fullPositionExit ?? false,
    liquidateResidualTokenToSol: input.liquidateResidualTokenToSol ?? false,
    runId: input.runId,
    lifecycleKey: input.lifecycleKey,
    openIntentId: input.openIntentId,
    ...(input.positionId ? { positionId: input.positionId } : {}),
    ...(input.chainPositionAddress ? { chainPositionAddress: input.chainPositionAddress } : {}),
    configSnapshotId: input.configSnapshotId,
    riskSnapshotId: input.riskSnapshotId,
    ...(input.maxInputSol !== undefined ? { maxInputSol: input.maxInputSol } : {}),
    ...(input.minOutputSol !== undefined ? { minOutputSol: input.minOutputSol } : {}),
    maxSlippageBps: input.maxSlippageBps,
    maxImpactBps: input.maxImpactBps,
    quotedImpactBps: input.quotedImpactBps,
    maxTotalFeeLamports: input.maxTotalFeeLamports,
    estimatedTotalFeeLamports: input.estimatedTotalFeeLamports,
    quoteHash: input.quoteHash,
    quoteSlot: input.quoteSlot,
    quoteCreatedAt: input.quoteCreatedAt,
    ...(input.candidateObservedAt ? { candidateObservedAt: input.candidateObservedAt } : {}),
    expiresAt: input.expiresAt,
    lastValidBlockHeight: input.lastValidBlockHeight
  });
}
