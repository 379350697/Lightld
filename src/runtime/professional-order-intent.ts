import {
  buildOrderIntentV2,
  type OrderSide
} from '../execution/order-intent-builder.ts';
import {
  computeIntentQuoteHash,
  type ExecutionMode,
  type LiveOrderIntentV2
} from '../execution/live-order-intent-schema.ts';
import {
  evaluateRiskIncrease,
  type RiskLimitsV2
} from '../risk/risk-policy-v2.ts';
import type { RiskStateV2 } from '../risk/risk-state-v2.ts';

export type ProfessionalOrderAction = OrderSide;

export type ProfessionalQuoteEvidence = {
  action: ProfessionalOrderAction;
  poolAddress: string;
  tokenMint: string;
  requestedPositionSol: number;
  chainPositionAddress?: string;
  routeExists: boolean;
  outputSol: number;
  slippageBps: number;
  quotedAt: string;
  quoteSlot: number;
  impactBps: number;
  estimatedTotalFeeLamports: number;
  maxTotalFeeLamports: number;
  lastValidBlockHeight: number;
  expiresAt: string;
  stale?: boolean;
  quoteHash?: string;
};

export type ProfessionalRunBinding = {
  runId: string;
  mode: ExecutionMode;
  configSnapshotId: string;
  parameterSnapshot: Record<string, unknown>;
};

export type ProfessionalLifecycleBinding = {
  lifecycleKey: string;
  openIntentId: string;
  positionId?: string;
  chainPositionAddress?: string;
};

export function buildProfessionalQuoteCommitment(quote: Omit<ProfessionalQuoteEvidence, 'quoteHash' | 'stale'>) {
  return {
    action: quote.action,
    poolAddress: quote.poolAddress,
    tokenMint: quote.tokenMint,
    requestedPositionSol: quote.requestedPositionSol,
    ...(quote.chainPositionAddress ? { chainPositionAddress: quote.chainPositionAddress } : {}),
    routeExists: quote.routeExists,
    outputSol: quote.outputSol,
    slippageBps: quote.slippageBps,
    quotedAt: quote.quotedAt,
    quoteSlot: quote.quoteSlot,
    impactBps: quote.impactBps,
    estimatedTotalFeeLamports: quote.estimatedTotalFeeLamports,
    maxTotalFeeLamports: quote.maxTotalFeeLamports,
    lastValidBlockHeight: quote.lastValidBlockHeight,
    expiresAt: quote.expiresAt
  };
}

function isRiskIncreasing(side: ProfessionalOrderAction) {
  return side === 'buy' || side === 'add-lp' || side === 'rebalance-lp';
}

function isExitWithProceeds(side: ProfessionalOrderAction) {
  return side === 'sell' || side === 'withdraw-lp';
}

function requireQuoteEvidence(quote: ProfessionalQuoteEvidence) {
  const required = [
    quote.quoteHash,
    quote.quoteSlot,
    quote.quotedAt,
    quote.expiresAt,
    quote.lastValidBlockHeight,
    quote.maxTotalFeeLamports
  ];
  if (
    !quote.routeExists
    || quote.stale
    || required.some((value) => value === undefined || value === null || value === '')
  ) {
    throw new Error('professional quote evidence is incomplete or no route is executable');
  }
  const expectedQuoteHash = computeIntentQuoteHash(buildProfessionalQuoteCommitment(quote));
  if (quote.quoteHash !== expectedQuoteHash) {
    throw new Error('professional quote commitment does not match supplied evidence');
  }
  if (
    !Number.isFinite(quote.outputSol)
    || quote.outputSol <= 0
    || !Number.isFinite(quote.slippageBps)
    || quote.slippageBps < 0
    || !Number.isFinite(quote.impactBps)
    || quote.impactBps < 0
    || !Number.isInteger(quote.maxTotalFeeLamports)
    || quote.maxTotalFeeLamports < 0
    || !Number.isInteger(quote.estimatedTotalFeeLamports)
    || quote.estimatedTotalFeeLamports < 0
  ) {
    throw new Error('professional quote evidence contains invalid execution bounds');
  }
}

export function buildProfessionalOrderIntent(input: {
  strategyId: string;
  action: ProfessionalOrderAction;
  poolAddress: string;
  tokenMint: string;
  requestedPositionSol: number;
  quote: ProfessionalQuoteEvidence;
  candidateObservedAt?: string;
  lifecycle: ProfessionalLifecycleBinding;
  run: ProfessionalRunBinding;
  riskState: RiskStateV2;
  riskLimits: RiskLimitsV2;
  now?: string;
}): LiveOrderIntentV2 {
  requireQuoteEvidence(input.quote);
  if (input.quote.action !== input.action
    || input.quote.poolAddress !== input.poolAddress
    || input.quote.tokenMint !== input.tokenMint
    || input.quote.requestedPositionSol !== input.requestedPositionSol) {
    throw new Error('professional quote identity does not match order intent');
  }
  if (isRiskIncreasing(input.action)) {
    if (!input.candidateObservedAt) {
      throw new Error('risk-increasing professional intent requires candidate observedAt');
    }
    const decision = evaluateRiskIncrease(
      input.riskState,
      { amountSol: input.requestedPositionSol },
      input.riskLimits
    );
    if (!decision.allowed) {
      throw new Error(`${decision.reason}: ${decision.detail}`);
    }
  }
  const minOutputSol = isExitWithProceeds(input.action)
    ? Math.max(1e-12, input.quote.outputSol * (1 - input.quote.slippageBps / 10_000))
    : undefined;

  return buildOrderIntentV2({
    strategyId: input.strategyId,
    poolAddress: input.poolAddress,
    tokenMint: input.tokenMint,
    outputSol: input.requestedPositionSol,
    side: input.action,
    createdAt: input.now,
    runId: input.run.runId,
    lifecycleKey: input.lifecycle.lifecycleKey,
    openIntentId: input.lifecycle.openIntentId,
    positionId: input.lifecycle.positionId,
    chainPositionAddress: input.lifecycle.chainPositionAddress,
    configSnapshotId: input.run.configSnapshotId,
    riskSnapshotId: input.riskState.riskSnapshotId,
    maxInputSol: isRiskIncreasing(input.action) ? input.requestedPositionSol : undefined,
    minOutputSol,
    maxSlippageBps: Math.ceil(input.quote.slippageBps),
    maxImpactBps: Math.ceil(input.quote.impactBps),
    quotedImpactBps: input.quote.impactBps,
    maxTotalFeeLamports: input.quote.maxTotalFeeLamports,
    estimatedTotalFeeLamports: input.quote.estimatedTotalFeeLamports,
    quoteHash: input.quote.quoteHash!,
    quoteSlot: input.quote.quoteSlot,
    quoteCreatedAt: input.quote.quotedAt,
    candidateObservedAt: input.candidateObservedAt,
    expiresAt: input.quote.expiresAt,
    lastValidBlockHeight: input.quote.lastValidBlockHeight,
    fullPositionExit: input.action === 'sell' || input.action === 'withdraw-lp',
    liquidateResidualTokenToSol: input.action === 'withdraw-lp' || input.action === 'claim-fee'
  });
}
