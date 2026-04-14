import type { ConfirmationStatus } from '../execution/confirmation-tracker.ts';
import type { ExecutionFailureKind } from '../execution/error-classification.ts';
import type { ConfirmationFinality } from '../execution/live-confirmation-provider.ts';
import type { LiveBroadcastResult } from '../execution/live-broadcaster.ts';
import type { LiveOrderIntent } from '../execution/live-signer.ts';
import type { ExecutionPlan, SolExitQuote } from '../execution/types.ts';
import type { PendingSubmissionSnapshot } from './state-types.ts';
import { toPendingConfirmationStatus, type PendingFinality } from './state-types.ts';
import type { LiveAction } from './action-semantics.ts';

type BaseResultInput = {
  action: LiveAction;
  audit: { reason: string };
  context: ReturnType<typeof import('./build-decision-context.ts').buildDecisionContext>;
  journalPaths: {
    decisionAuditPath: string;
    quoteJournalPath: string;
    liveOrderPath: string;
    liveFillPath: string;
    liveIncidentPath: string;
  };
  killSwitchState: boolean;
  quote?: SolExitQuote;
  executionPlan?: ExecutionPlan;
  orderIntent?: LiveOrderIntent;
  broadcastResult?: LiveBroadcastResult;
  confirmationStatus?: ConfirmationStatus;
  failureKind?: ExecutionFailureKind;
  failureSource?: 'quote' | 'signer' | 'broadcast' | 'confirmation' | 'account' | 'recovery' | 'runtime-policy';
};

export function buildBlockedCycleResult(
  input: BaseResultInput & {
    reason: string;
    quoteCollected: boolean;
  }
) {
  return {
    status: 'ok' as const,
    mode: 'BLOCKED' as const,
    action: input.action,
    reason: input.reason,
    audit: input.audit,
    context: input.context,
    quoteCollected: input.quoteCollected,
    quote: input.quote,
    executionPlan: input.executionPlan,
    liveOrderSubmitted: false,
    orderIntent: input.orderIntent,
    broadcastResult: input.broadcastResult,
    confirmationStatus: input.confirmationStatus,
    failureKind: input.failureKind,
    failureSource: input.failureSource,
    journalPaths: input.journalPaths,
    killSwitchState: input.killSwitchState
  };
}

export function buildLiveSubmittedResult(
  input: BaseResultInput & {
    reason: string;
  }
) {
  return {
    status: 'ok' as const,
    mode: 'LIVE' as const,
    action: input.action,
    reason: input.reason,
    audit: input.audit,
    context: input.context,
    quoteCollected: true,
    quote: input.quote,
    executionPlan: input.executionPlan,
    liveOrderSubmitted: true,
    orderIntent: input.orderIntent,
    broadcastResult: input.broadcastResult,
    confirmationStatus: input.confirmationStatus,
    journalPaths: input.journalPaths,
    killSwitchState: input.killSwitchState
  };
}

export function buildUnknownPendingSubmissionSnapshot(input: {
  strategyId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  timeoutAt: string;
  tokenMint: string;
  tokenSymbol: string;
  reason: string;
}): PendingSubmissionSnapshot {
  return {
    strategyId: input.strategyId,
    idempotencyKey: input.idempotencyKey,
    submissionId: '',
    confirmationSignature: undefined,
    confirmationStatus: 'unknown',
    finality: 'unknown',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastCheckedAt: input.updatedAt,
    timeoutAt: input.timeoutAt,
    tokenMint: input.tokenMint,
    tokenSymbol: input.tokenSymbol,
    reason: input.reason
  };
}

export function buildTrackedPendingSubmissionSnapshot(input: {
  strategyId: string;
  idempotencyKey: string;
  submissionId: string;
  confirmationSignature?: string;
  confirmationStatus: ConfirmationStatus;
  finality: ConfirmationFinality;
  createdAt: string;
  updatedAt: string;
  timeoutAt: string;
  tokenMint: string;
  tokenSymbol: string;
  reason?: string;
}): PendingSubmissionSnapshot {
  return {
    strategyId: input.strategyId,
    idempotencyKey: input.idempotencyKey,
    submissionId: input.submissionId,
    confirmationSignature: input.confirmationSignature,
    confirmationStatus: toPendingConfirmationStatus(input.confirmationStatus),
    finality: input.finality as PendingFinality,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastCheckedAt: input.updatedAt,
    timeoutAt: input.timeoutAt,
    tokenMint: input.tokenMint,
    tokenSymbol: input.tokenSymbol,
    reason: input.reason
  };
}

export function resolveFillMirrorSide(action: LiveAction) {
  if (action === 'deploy') {
    return 'buy' as const;
  }

  if (action === 'dca-out') {
    return 'sell' as const;
  }

  return 'unknown' as const;
}
