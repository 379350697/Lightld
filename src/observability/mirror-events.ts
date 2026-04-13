import type { ConfirmationStatus } from '../execution/confirmation-tracker.ts';
import type { RuntimeMode, PendingFinality } from '../runtime/state-types.ts';
import type { MirrorEventPriority } from './mirror-types.ts';

export type CycleRunMirrorPayload = {
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
  confirmationStatus: ConfirmationStatus;
  reconciliationOk: boolean;
  durationMs: number;
};

export type OrderMirrorPayload = {
  idempotencyKey: string;
  cycleId: string;
  strategyId: string;
  submissionId: string;
  confirmationSignature: string;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  action: 'hold' | 'deploy' | 'dca-out' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp' | 'unknown';
  requestedPositionSol: number;
  quotedOutputSol: number;
  broadcastStatus: 'pending' | 'submitted' | 'failed' | 'unknown';
  confirmationStatus: ConfirmationStatus;
  finality: PendingFinality | 'unknown';
  createdAt: string;
  updatedAt: string;
};

export type FillMirrorPayload = {
  fillId: string;
  submissionId: string;
  confirmationSignature: string;
  cycleId: string;
  tokenMint: string;
  tokenSymbol: string;
  side: 'buy' | 'sell' | 'unknown';
  amount: number;
  filledSol: number;
  recordedAt: string;
};

export type ReconciliationMirrorPayload = {
  cycleId: string;
  walletSol: number;
  journalSol: number;
  deltaSol: number;
  tokenDeltaCount: number;
  ok: boolean;
  reason: string;
  recordedAt: string;
  rawJson: string;
};

export type IncidentMirrorPayload = {
  incidentId: string;
  cycleId: string;
  stage: string;
  severity: 'warning' | 'error';
  reason: string;
  runtimeMode: RuntimeMode;
  submissionId: string;
  tokenMint: string;
  tokenSymbol: string;
  recordedAt: string;
};

export type RuntimeSnapshotMirrorPayload = {
  snapshotAt: string;
  runtimeMode: RuntimeMode;
  allowNewOpens: boolean;
  flattenOnly: boolean;
  pendingSubmission: boolean;
  circuitReason: string;
  quoteFailures: number;
  reconcileFailures: number;
};

type MirrorEventBase<TType extends string, TPayload> = {
  type: TType;
  priority: MirrorEventPriority;
  payload: TPayload;
};

export type CycleRunMirrorEvent = MirrorEventBase<'cycle_run', CycleRunMirrorPayload>;
export type OrderMirrorEvent = MirrorEventBase<'order', OrderMirrorPayload>;
export type FillMirrorEvent = MirrorEventBase<'fill', FillMirrorPayload>;
export type ReconciliationMirrorEvent = MirrorEventBase<'reconciliation', ReconciliationMirrorPayload>;
export type IncidentMirrorEvent = MirrorEventBase<'incident', IncidentMirrorPayload>;
export type RuntimeSnapshotMirrorEvent = MirrorEventBase<'runtime_snapshot', RuntimeSnapshotMirrorPayload>;

export type MirrorEvent =
  | CycleRunMirrorEvent
  | OrderMirrorEvent
  | FillMirrorEvent
  | ReconciliationMirrorEvent
  | IncidentMirrorEvent
  | RuntimeSnapshotMirrorEvent;

export type MirrorEventSink = {
  enqueue(event: MirrorEvent): void;
};
