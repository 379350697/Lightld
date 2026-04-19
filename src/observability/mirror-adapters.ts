import type { ConfirmationStatus } from '../execution/confirmation-tracker.ts';
import { summarizeAccountEquity } from '../runtime/account-equity.ts';
import type { LiveAccountState } from '../runtime/live-account-provider.ts';
import type { HealthReport, PendingFinality, RuntimeMode } from '../runtime/state-types.ts';
import type {
  CandidateScanMirrorEvent,
  CandidateScanMirrorPayload,
  CycleRunMirrorEvent,
  CycleRunMirrorPayload,
  FillMirrorEvent,
  FillMirrorPayload,
  IncidentMirrorEvent,
  IncidentMirrorPayload,
  OrderMirrorEvent,
  OrderMirrorPayload,
  ReconciliationMirrorEvent,
  ReconciliationMirrorPayload,
  RuntimeSnapshotMirrorEvent,
  WatchlistSnapshotMirrorEvent,
  WatchlistSnapshotMirrorPayload
} from './mirror-events.ts';

export function toRuntimeSnapshotEvent(
  report: HealthReport,
  accountState?: Pick<LiveAccountState, 'walletSol' | 'walletLpPositions'> | null
): RuntimeSnapshotMirrorEvent {
  const equity = summarizeAccountEquity(accountState);

  return {
    type: 'runtime_snapshot',
    priority: 'high',
    payload: {
      snapshotAt: report.updatedAt,
      runtimeMode: report.mode,
      allowNewOpens: report.allowNewOpens,
      flattenOnly: report.flattenOnly,
      pendingSubmission: report.pendingSubmission,
      circuitReason: report.circuitReason,
      quoteFailures: report.dependencyHealth.quoteFailures,
      reconcileFailures: report.dependencyHealth.reconcileFailures,
      walletSol: equity.walletSol,
      lpValueSol: equity.lpValueSol,
      unclaimedFeeSol: equity.unclaimedFeeSol,
      netWorthSol: equity.netWorthSol,
      openPositionCount: equity.openPositionCount
    }
  };
}

export function toCandidateScanMirrorEvent(payload: CandidateScanMirrorPayload): CandidateScanMirrorEvent {
  return {
    type: 'candidate_scan',
    priority: 'low',
    payload
  };
}

export function toWatchlistSnapshotMirrorEvent(
  payload: WatchlistSnapshotMirrorPayload
): WatchlistSnapshotMirrorEvent {
  return {
    type: 'watchlist_snapshot',
    priority: 'low',
    payload
  };
}

export function toCycleRunEvent(payload: CycleRunMirrorPayload): CycleRunMirrorEvent {
  return {
    type: 'cycle_run',
    priority: 'medium',
    payload
  };
}

export function toOrderMirrorEvent(payload: OrderMirrorPayload): OrderMirrorEvent {
  return {
    type: 'order',
    priority: 'high',
    payload
  };
}

export function toFillMirrorEvent(payload: FillMirrorPayload): FillMirrorEvent {
  return {
    type: 'fill',
    priority: 'high',
    payload
  };
}

export function toReconciliationMirrorEvent(
  payload: ReconciliationMirrorPayload
): ReconciliationMirrorEvent {
  return {
    type: 'reconciliation',
    priority: 'medium',
    payload
  };
}

export function toIncidentMirrorEvent(payload: IncidentMirrorPayload): IncidentMirrorEvent {
  return {
    type: 'incident',
    priority: 'high',
    payload
  };
}

export function buildOrderMirrorPayload(input: {
  idempotencyKey: string;
  cycleId: string;
  strategyId: string;
  submissionId?: string;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
  confirmationSignature?: string;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  action: 'hold' | 'deploy' | 'dca-out' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp' | 'unknown';
  requestedPositionSol: number;
  quotedOutputSol: number;
  broadcastStatus: 'pending' | 'submitted' | 'failed' | 'unknown';
  confirmationStatus: ConfirmationStatus;
  finality?: PendingFinality | 'unknown';
  createdAt: string;
  updatedAt: string;
}): OrderMirrorPayload {
  return {
    idempotencyKey: input.idempotencyKey,
    cycleId: input.cycleId,
    strategyId: input.strategyId,
    submissionId: input.submissionId ?? '',
    openIntentId: input.openIntentId,
    positionId: input.positionId,
    chainPositionAddress: input.chainPositionAddress,
    confirmationSignature: input.confirmationSignature ?? '',
    poolAddress: input.poolAddress,
    tokenMint: input.tokenMint,
    tokenSymbol: input.tokenSymbol,
    action: input.action,
    requestedPositionSol: input.requestedPositionSol,
    quotedOutputSol: input.quotedOutputSol,
    broadcastStatus: input.broadcastStatus,
    confirmationStatus: input.confirmationStatus,
    finality: input.finality ?? 'unknown',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

export function buildCycleRunMirrorPayload(input: {
  cycleId: string;
  strategyId: string;
  startedAt: string;
  finishedAt: string;
  runtimeMode: RuntimeMode;
  sessionPhase: 'active' | 'flatten-only' | 'closed';
  action: 'hold' | 'deploy' | 'dca-out' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';
  resultMode: 'LIVE' | 'BLOCKED';
  reason: string;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  requestedPositionSol: number;
  quoteCollected: boolean;
  liveOrderSubmitted: boolean;
  confirmationStatus?: ConfirmationStatus;
  reconciliationOk: boolean;
  durationMs: number;
}): CycleRunMirrorPayload {
  return {
    cycleId: input.cycleId,
    strategyId: input.strategyId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    runtimeMode: input.runtimeMode,
    sessionPhase: input.sessionPhase,
    action: input.action,
    resultMode: input.resultMode,
    reason: input.reason,
    poolAddress: input.poolAddress,
    tokenMint: input.tokenMint,
    tokenSymbol: input.tokenSymbol,
    requestedPositionSol: input.requestedPositionSol,
    quoteCollected: input.quoteCollected,
    liveOrderSubmitted: input.liveOrderSubmitted,
    confirmationStatus: input.confirmationStatus ?? 'unknown',
    reconciliationOk: input.reconciliationOk,
    durationMs: input.durationMs
  };
}
