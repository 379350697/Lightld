import { createPositionId } from './lp-position-record.ts';
import { positionLedgerKey } from './position-ledger.ts';
import type {
  LifecycleEventRecord,
  PositionLedgerRecord,
  PositionLedgerSnapshot
} from './state-types.ts';

function sortEvents(events: LifecycleEventRecord[]) {
  return [...events].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.eventKey.localeCompare(right.eventKey)
  );
}

function recordMatchesEvent(record: PositionLedgerRecord, event: LifecycleEventRecord) {
  if (event.chainPositionAddress) {
    if (
      record.chainPositionAddress === event.chainPositionAddress
      || record.positionId === event.chainPositionAddress
      || record.positionKey === `chain-position:${event.chainPositionAddress}`
    ) {
      return true;
    }
  }

  if (event.openIntentId && record.openIntentId === event.openIntentId) {
    return true;
  }

  if (event.idempotencyKey && record.idempotencyKey === event.idempotencyKey) {
    return true;
  }

  return Boolean(
    event.poolAddress &&
    event.tokenMint &&
    record.activePoolAddress === event.poolAddress &&
    record.activeMint === event.tokenMint
  );
}

function upsertRecord(records: PositionLedgerRecord[], next: PositionLedgerRecord) {
  const index = records.findIndex((record) => record.positionKey === next.positionKey);
  if (index >= 0) {
    records[index] = next;
    return;
  }
  records.push(next);
}

function eventTargetKey(event: LifecycleEventRecord) {
  return positionLedgerKey({
    chainPositionAddress: event.chainPositionAddress,
    positionId: event.chainPositionAddress || !event.openIntentId ? event.positionId : undefined,
    openIntentId: event.openIntentId,
    idempotencyKey: event.idempotencyKey,
    poolAddress: event.poolAddress,
    mint: event.tokenMint
  });
}

function supersedeSyntheticRecords(input: {
  records: PositionLedgerRecord[];
  chainRecord: PositionLedgerRecord;
  now: string;
  reason: string;
}) {
  const poolMintFallbackCanSupersede = (candidate: PositionLedgerRecord) => {
    if (
      !candidate.missingOnChainSince ||
      !input.chainRecord.lastClosedAt ||
      candidate.activePoolAddress !== input.chainRecord.activePoolAddress ||
      candidate.activeMint !== input.chainRecord.activeMint
    ) {
      return false;
    }

    const candidateOpenedAtMs = candidate.openedAt ? Date.parse(candidate.openedAt) : Number.NaN;
    const chainClosedAtMs = Date.parse(input.chainRecord.lastClosedAt);
    return Number.isFinite(candidateOpenedAtMs) && Number.isFinite(chainClosedAtMs)
      ? candidateOpenedAtMs <= chainClosedAtMs
      : false;
  };

  for (let index = 0; index < input.records.length; index += 1) {
    const candidate = input.records[index];
    if (
      candidate.positionKey === input.chainRecord.positionKey ||
      candidate.chainPositionAddress ||
      candidate.lifecycleState === 'closed'
    ) {
      continue;
    }

    const matches = Boolean(
      (candidate.openIntentId && candidate.openIntentId === input.chainRecord.openIntentId)
      || (candidate.idempotencyKey && candidate.idempotencyKey === input.chainRecord.idempotencyKey)
      || (candidate.entryFillSubmissionId && candidate.entryFillSubmissionId === input.chainRecord.entryFillSubmissionId)
      || poolMintFallbackCanSupersede(candidate)
    );

    if (!matches) {
      continue;
    }

    input.records[index] = {
      ...candidate,
      lifecycleState: 'closed',
      importStatus: 'superseded_closed',
      supersededByPositionKey: input.chainRecord.positionKey,
      lastReason: input.reason,
      lastClosedAt: input.now,
      updatedAt: input.now
    };
  }
}

export function reduceLifecycleEventsToLedger(input: {
  events: LifecycleEventRecord[];
  previousLedger?: PositionLedgerSnapshot | null;
  now: string;
}): PositionLedgerSnapshot {
  const records = [...(input.previousLedger?.records ?? [])];

  for (const event of sortEvents(input.events)) {
    if (
      event.eventType === 'BroadcastNotSubmitted' ||
      event.eventType === 'SignFailed' ||
      event.eventType === 'OrderSignFailed'
    ) {
      continue;
    }

    if (event.eventType === 'BroadcastSubmitted' && event.action === 'add-lp') {
      const existing = records.find((record) => recordMatchesEvent(record, event));
      const next: PositionLedgerRecord = {
        ...(existing ?? {
          positionKey: eventTargetKey(event),
          lifecycleState: 'open_pending' as const,
          lastAction: event.action ?? 'add-lp',
          updatedAt: event.createdAt
        }),
        positionKey: existing?.positionKey ?? eventTargetKey(event),
        openIntentId: event.openIntentId ?? existing?.openIntentId,
        idempotencyKey: event.idempotencyKey ?? existing?.idempotencyKey,
        positionId: event.positionId ?? existing?.positionId,
        activePoolAddress: event.poolAddress ?? existing?.activePoolAddress,
        activeMint: event.tokenMint ?? existing?.activeMint,
        lifecycleState: 'open_pending',
        pendingSubmissionId: event.submissionId ?? existing?.pendingSubmissionId,
        pendingOrderAction: 'add-lp',
        pendingConfirmationStatus: 'submitted',
        lastAction: 'add-lp',
        lastReason: event.reason ?? 'broadcast-submitted',
        updatedAt: event.createdAt
      };
      upsertRecord(records, next);
      continue;
    }

    if (event.eventType === 'ChainPositionObserved' && event.chainPositionAddress) {
      const existing = records.find((record) => recordMatchesEvent(record, event));
      const chainRecord: PositionLedgerRecord = {
        ...(existing ?? {
          lastAction: 'hold'
        }),
        positionKey: positionLedgerKey({
          chainPositionAddress: event.chainPositionAddress,
          poolAddress: event.poolAddress,
          mint: event.tokenMint
        }),
        openIntentId: event.openIntentId ?? existing?.openIntentId,
        idempotencyKey: event.idempotencyKey ?? existing?.idempotencyKey,
        positionId: createPositionId({ chainPositionAddress: event.chainPositionAddress }),
        chainPositionAddress: event.chainPositionAddress,
        activePoolAddress: event.poolAddress ?? existing?.activePoolAddress,
        activeMint: event.tokenMint ?? existing?.activeMint,
        lifecycleState: 'open',
        lastAction: existing?.lastAction ?? 'hold',
        lastReason: event.reason ?? existing?.lastReason,
        missingOnChainSince: undefined,
        updatedAt: event.createdAt
      };
      if (existing && existing.positionKey !== chainRecord.positionKey) {
        const index = records.findIndex((record) => record.positionKey === existing.positionKey);
        if (index >= 0) {
          records.splice(index, 1);
        }
      }
      upsertRecord(records, chainRecord);
      supersedeSyntheticRecords({
        records,
        chainRecord,
        now: event.createdAt,
        reason: 'superseded-by-chain-position'
      });
      continue;
    }

    if (event.eventType === 'PositionClosed' || event.eventType === 'ReconciledClosed') {
      const existing = records.find((record) => recordMatchesEvent(record, event));
      if (!existing) {
        continue;
      }

      const closedRecord: PositionLedgerRecord = {
        ...existing,
        lifecycleState: 'closed',
        lastAction: event.action ?? 'withdraw-lp',
        lastReason: event.reason ?? 'position-closed',
        lastClosedAt: event.createdAt,
        updatedAt: event.createdAt
      };
      upsertRecord(records, closedRecord);
      supersedeSyntheticRecords({
        records,
        chainRecord: closedRecord,
        now: event.createdAt,
        reason: 'superseded-by-chain-closed-position'
      });
      continue;
    }

    if (event.eventType === 'ResidualCleanupRequired' || event.eventType === 'ResidualCleanupResolved') {
      const existing = records.find((record) => recordMatchesEvent(record, event));
      if (!existing) {
        continue;
      }

      upsertRecord(records, {
        ...existing,
        residualCleanupStatus: event.eventType === 'ResidualCleanupResolved'
          ? 'residual_cleanup_complete'
          : event.residualCleanupStatus ?? 'residual_cleanup_pending',
        residualCleanupValueSol: event.residualCleanupValueSol ?? existing.residualCleanupValueSol,
        updatedAt: event.createdAt
      });
    }
  }

  return {
    version: 1,
    records,
    updatedAt: sortEvents(input.events).at(-1)?.createdAt ?? input.previousLedger?.updatedAt ?? input.now
  };
}
