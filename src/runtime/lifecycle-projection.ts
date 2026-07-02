import type { LiveAccountState } from './live-account-provider.ts';
import type {
  OrderAttemptRecord,
  OrderAttemptStatus,
  PendingSubmissionSnapshot,
  PositionLedgerRecord,
  PositionLedgerSnapshot
} from './state-types.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);

export type ProjectedPositionClass =
  | 'closed'
  | 'failed_terminal'
  | 'chain_active'
  | 'pending_open'
  | 'reconcile_required'
  | 'inactive';

export type LifecycleProjection = {
  chainActiveLpCount: number;
  pendingOpenCount: number;
  reconcileRequiredCount: number;
  residualCleanupRequiredCount: number;
  activeLpCount: number;
  managedLpCount: number;
  importFailedLpCount: number;
  allowNewOpens: boolean;
  businessActiveRecords: PositionLedgerRecord[];
  pendingOpenRecords: PositionLedgerRecord[];
  reconcileRequiredRecords: PositionLedgerRecord[];
};

function pendingSubmissionMatchesRecord(
  record: PositionLedgerRecord,
  pendingSubmission?: PendingSubmissionSnapshot | null
) {
  if (!pendingSubmission || pendingSubmission.confirmationStatus === 'failed') {
    return false;
  }

  if (pendingSubmission.orderAction !== 'add-lp' && pendingSubmission.orderAction !== 'deploy') {
    return false;
  }

  if (record.pendingSubmissionId && record.pendingSubmissionId === pendingSubmission.submissionId) {
    return true;
  }

  if (record.idempotencyKey && record.idempotencyKey === pendingSubmission.idempotencyKey) {
    return true;
  }

  if (record.openIntentId && record.openIntentId === pendingSubmission.openIntentId) {
    return true;
  }

  return Boolean(
    record.activePoolAddress &&
    record.activeMint &&
    record.activePoolAddress === pendingSubmission.poolAddress &&
    record.activeMint === pendingSubmission.tokenMint
  );
}

export function isSubmittedPendingOpenRecord(
  record: PositionLedgerRecord,
  pendingSubmission?: PendingSubmissionSnapshot | null
) {
  if (record.lifecycleState !== 'open_pending') {
    return false;
  }

  if (pendingSubmissionMatchesRecord(record, pendingSubmission)) {
    return true;
  }

  if (record.missingOnChainSince) {
    return false;
  }

  return Boolean(
    record.pendingOrderAction === 'add-lp' &&
    record.pendingSubmissionId &&
    record.pendingConfirmationStatus &&
    record.pendingConfirmationStatus !== 'failed' &&
    record.lastReason !== 'http-400'
  );
}

export function classifyPositionRecord(
  record: PositionLedgerRecord,
  pendingSubmission?: PendingSubmissionSnapshot | null
): ProjectedPositionClass {
  if (record.lifecycleState === 'closed') {
    return 'closed';
  }

  if (record.lifecycleState === 'failed_terminal') {
    return 'failed_terminal';
  }

  if (record.lifecycleState === 'reconcile_required') {
    return 'reconcile_required';
  }

  if (record.chainPositionAddress) {
    return record.missingOnChainSince ? 'reconcile_required' : 'chain_active';
  }

  if (isSubmittedPendingOpenRecord(record, pendingSubmission)) {
    return 'pending_open';
  }

  if (record.lifecycleState === 'open_pending') {
    return 'reconcile_required';
  }

  return record.missingOnChainSince ? 'reconcile_required' : 'inactive';
}

export function isPositionRecordBusinessActive(
  record: PositionLedgerRecord,
  pendingSubmission?: PendingSubmissionSnapshot | null
) {
  const classification = classifyPositionRecord(record, pendingSubmission);
  return classification === 'chain_active' || classification === 'pending_open';
}

function isNonStableMint(mint?: string) {
  return typeof mint === 'string' && mint.length > 0 && mint !== SOL_MINT && !STABLE_MINTS.has(mint);
}

function collectChainActiveKeys(accountState?: LiveAccountState) {
  const keys = new Set<string>();

  for (const position of [
    ...(accountState?.walletLpPositions ?? []),
    ...(accountState?.journalLpPositions ?? [])
  ]) {
    if (!isNonStableMint(position.mint) || !(position.hasLiquidity ?? true)) {
      continue;
    }

    const key = position.chainPositionAddress
      || position.positionAddress
      || position.positionId
      || `${position.poolAddress ?? ''}:${position.mint ?? ''}`;
    if (key) {
      keys.add(key);
    }
  }

  return keys;
}

function recordMatchesChainActiveRecord(record: PositionLedgerRecord, chainRecord: PositionLedgerRecord) {
  if (record === chainRecord) {
    return false;
  }

  if (record.openIntentId && record.openIntentId === chainRecord.openIntentId) {
    return true;
  }

  if (record.idempotencyKey && record.idempotencyKey === chainRecord.idempotencyKey) {
    return true;
  }

  if (record.entryFillSubmissionId && record.entryFillSubmissionId === chainRecord.entryFillSubmissionId) {
    return true;
  }

  return Boolean(
    record.activePoolAddress &&
    record.activeMint &&
    record.activePoolAddress === chainRecord.activePoolAddress &&
    record.activeMint === chainRecord.activeMint
  );
}

function recordMatchesClosedChainRecord(record: PositionLedgerRecord, chainRecord: PositionLedgerRecord) {
  if (record.openIntentId || record.idempotencyKey || record.entryFillSubmissionId) {
    return Boolean(
      (record.openIntentId && record.openIntentId === chainRecord.openIntentId)
      || (record.idempotencyKey && record.idempotencyKey === chainRecord.idempotencyKey)
      || (record.entryFillSubmissionId && record.entryFillSubmissionId === chainRecord.entryFillSubmissionId)
    );
  }

  if (!recordMatchesChainActiveRecord(record, chainRecord)) {
    return false;
  }

  if (!record.missingOnChainSince || !chainRecord.lastClosedAt) {
    return false;
  }

  const recordOpenedAtMs = record.openedAt ? Date.parse(record.openedAt) : Number.NaN;
  const chainClosedAtMs = Date.parse(chainRecord.lastClosedAt);
  return Number.isFinite(recordOpenedAtMs) && Number.isFinite(chainClosedAtMs)
    ? recordOpenedAtMs <= chainClosedAtMs
    : false;
}

function isSupersededByChainRecord(
  record: PositionLedgerRecord,
  chainRecords: PositionLedgerRecord[]
) {
  if (record.chainPositionAddress) {
    return false;
  }

  return chainRecords.some((chainRecord) => {
    if (chainRecord.lifecycleState === 'closed') {
      return recordMatchesClosedChainRecord(record, chainRecord);
    }
    return recordMatchesChainActiveRecord(record, chainRecord);
  });
}

function isResidualCleanupRequired(record: PositionLedgerRecord) {
  return record.residualCleanupStatus === 'residual_cleanup_pending';
}

export function buildLifecycleProjection(input: {
  ledger?: PositionLedgerSnapshot | null;
  pendingSubmission?: PendingSubmissionSnapshot | null;
  accountState?: LiveAccountState;
  maxActivePositions?: number;
  blockNewOpensOnReconcileRequired?: boolean;
}): LifecycleProjection {
  const records = input.ledger?.records ?? [];
  const classifications = records.map((record) => ({
    record,
    classification: classifyPositionRecord(record, input.pendingSubmission)
  }));
  const businessActiveRecords = classifications
    .filter((entry) => entry.classification === 'chain_active' || entry.classification === 'pending_open')
    .map((entry) => entry.record);
  const chainActiveRecords = classifications
    .filter((entry) => entry.classification === 'chain_active')
    .map((entry) => entry.record);
  const pendingOpenRecords = classifications
    .filter((entry) => entry.classification === 'pending_open')
    .map((entry) => entry.record);
  const supersedingChainRecords = classifications
    .filter((entry) => entry.classification === 'chain_active' || entry.classification === 'closed')
    .map((entry) => entry.record);
  const reconcileRequiredRecords = classifications
    .filter((entry) => (
      entry.classification === 'reconcile_required' &&
      !isSupersededByChainRecord(entry.record, supersedingChainRecords)
    ))
    .map((entry) => entry.record);
  const residualCleanupRequiredCount = records.filter(isResidualCleanupRequired).length;
  const chainActiveKeys = collectChainActiveKeys(input.accountState);
  const chainActiveLpCount = Math.max(chainActiveRecords.length, chainActiveKeys.size);
  const pendingOpenCount = pendingOpenRecords.length;
  const reconcileRequiredCount = reconcileRequiredRecords.length;
  const maxActivePositions = input.maxActivePositions ?? 5;
  const blockNewOpensOnReconcileRequired = input.blockNewOpensOnReconcileRequired ?? true;
  const capacityUsed = chainActiveLpCount + pendingOpenCount;

  return {
    chainActiveLpCount,
    pendingOpenCount,
    reconcileRequiredCount,
    residualCleanupRequiredCount,
    activeLpCount: capacityUsed,
    managedLpCount: businessActiveRecords.filter((record) => record.importStatus !== 'import_failed').length,
    importFailedLpCount: businessActiveRecords.filter((record) => record.importStatus === 'import_failed').length,
    allowNewOpens: capacityUsed < maxActivePositions
      && (!blockNewOpensOnReconcileRequired || reconcileRequiredCount === 0),
    businessActiveRecords,
    pendingOpenRecords,
    reconcileRequiredRecords
  };
}

function orderAttemptStatus(input: {
  action: string;
  reason?: string;
  detail?: string;
  liveOrderSubmitted: boolean;
  confirmationStatus?: string;
}): { status: OrderAttemptStatus; eventType: OrderAttemptRecord['eventType']; broadcastStatus: string } {
  if (input.liveOrderSubmitted) {
    if (input.confirmationStatus === 'confirmed' || input.confirmationStatus === 'failed') {
      return {
        status: 'confirmation_resolved',
        eventType: 'ConfirmationResolved',
        broadcastStatus: 'submitted'
      };
    }

    return {
      status: 'broadcast_submitted',
      eventType: 'BroadcastSubmitted',
      broadcastStatus: 'submitted'
    };
  }

  if (input.reason === 'sign-failed') {
    return {
      status: 'sign_failed',
      eventType: 'SignFailed',
      broadcastStatus: 'not_submitted'
    };
  }

  if (input.reason === 'http-400' || input.action === 'add-lp') {
    return {
      status: 'broadcast_not_submitted',
      eventType: 'BroadcastNotSubmitted',
      broadcastStatus: 'not_submitted'
    };
  }

  return {
    status: 'attempt_failed',
    eventType: 'BroadcastNotSubmitted',
    broadcastStatus: 'not_submitted'
  };
}

export function buildOrderAttemptRecord(input: {
  strategyId?: string;
  actionIdentity?: {
    openIntentId?: string;
    positionId?: string;
    chainPositionAddress?: string;
  };
  orderIntent?: {
    idempotencyKey?: string;
    poolAddress?: string;
    tokenMint?: string;
  };
  pendingSubmission?: PendingSubmissionSnapshot | null;
  action: string;
  reason?: string;
  detail?: string;
  liveOrderSubmitted: boolean;
  confirmationStatus?: string;
  finality?: string;
  now: string;
}): OrderAttemptRecord | undefined {
  if (!input.orderIntent && !input.pendingSubmission && !input.actionIdentity) {
    return undefined;
  }

  const status = orderAttemptStatus(input);
  const attemptKey = input.orderIntent?.idempotencyKey
    ?? input.pendingSubmission?.idempotencyKey
    ?? input.actionIdentity?.chainPositionAddress
    ?? input.actionIdentity?.positionId
    ?? input.actionIdentity?.openIntentId
    ?? `${input.action}:${input.now}`;

  return {
    attemptKey,
    strategyId: input.strategyId,
    openIntentId: input.actionIdentity?.openIntentId ?? input.pendingSubmission?.openIntentId,
    positionId: input.actionIdentity?.positionId ?? input.pendingSubmission?.positionId,
    chainPositionAddress: input.actionIdentity?.chainPositionAddress ?? input.pendingSubmission?.chainPositionAddress,
    idempotencyKey: input.orderIntent?.idempotencyKey ?? input.pendingSubmission?.idempotencyKey,
    submissionId: input.pendingSubmission?.submissionId,
    poolAddress: input.orderIntent?.poolAddress ?? input.pendingSubmission?.poolAddress,
    tokenMint: input.orderIntent?.tokenMint ?? input.pendingSubmission?.tokenMint,
    action: input.action,
    status: status.status,
    eventType: status.eventType,
    broadcastStatus: status.broadcastStatus,
    confirmationStatus: input.confirmationStatus ?? input.pendingSubmission?.confirmationStatus,
    finality: input.finality ?? input.pendingSubmission?.finality,
    liveOrderSubmitted: input.liveOrderSubmitted,
    reason: input.reason,
    detail: input.detail,
    createdAt: input.now,
    updatedAt: input.now
  };
}
