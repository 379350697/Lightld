import type { LiveAccountState } from './live-account-provider.ts';
import { evaluateLpRiskSentinel } from './lp-risk-sentinel.ts';
import { createPositionId } from './lp-position-record.ts';
import type {
  PendingSubmissionSnapshot,
  PositionLedgerRecord,
  PositionLedgerSnapshot,
  PositionStateSnapshot
} from './state-types.ts';
import {
  buildLifecycleProjection,
  isPositionRecordBusinessActive,
  isSubmittedPendingOpenRecord
} from './lifecycle-projection.ts';
import {
  isTrustedEntrySolSource,
  isTrustedLpOpenFill
} from './lp-entry-resolver.ts';
import {
  hasLightldLpOwnershipEvidence,
  positionStateOwnsLpPosition,
  UNBOUND_ACCOUNT_LP_REASON
} from './lp-ownership.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);
const CHAIN_POSITION_EVIDENCE_GRACE_MS = 5 * 60_000;

type AccountLpPosition = NonNullable<LiveAccountState['walletLpPositions']>[number];

function isNonStableMint(mint?: string) {
  return typeof mint === 'string' && mint.length > 0 && mint !== SOL_MINT && !STABLE_MINTS.has(mint);
}

function walletTokenAmountRaw(accountState: LiveAccountState | undefined, mint?: string) {
  if (!accountState || !mint) {
    return undefined;
  }
  let total = 0n;
  for (const token of accountState.walletTokens ?? []) {
    if (token.mint !== mint) {
      continue;
    }
    const raw = token.amountRaw
      ?? (typeof token.amountLamports === 'number' && Number.isSafeInteger(token.amountLamports) && token.amountLamports >= 0
        ? String(token.amountLamports)
        : undefined);
    if (!raw || !/^\d+$/.test(raw)) {
      return undefined;
    }
    total += BigInt(raw);
  }
  return total;
}

export function positionLedgerKey(input: {
  chainPositionAddress?: string;
  positionAddress?: string;
  positionId?: string;
  openIntentId?: string;
  idempotencyKey?: string;
  poolAddress?: string;
  mint?: string;
}) {
  const chainPositionAddress = input.chainPositionAddress || input.positionAddress;
  if (chainPositionAddress) {
    return `chain-position:${chainPositionAddress}`;
  }
  if (input.positionId) {
    return `position:${input.positionId}`;
  }
  if (input.openIntentId) {
    return `open-intent:${input.openIntentId}`;
  }
  if (input.idempotencyKey) {
    return `idempotency:${input.idempotencyKey}`;
  }
  return `pool-mint:${input.poolAddress ?? ''}:${input.mint ?? ''}`;
}

function activeLpKey(position: AccountLpPosition) {
  return positionLedgerKey({
    chainPositionAddress: position.chainPositionAddress,
    positionAddress: position.positionAddress,
    positionId: position.positionId,
    poolAddress: position.poolAddress,
    mint: position.mint
  });
}

export function collectActiveLpPositions(accountState?: LiveAccountState): AccountLpPosition[] {
  const positions: AccountLpPosition[] = [];
  const seen = new Set<string>();

  for (const position of [
    ...(accountState?.walletLpPositions ?? []),
    ...(accountState?.journalLpPositions ?? [])
  ]) {
    if (!isNonStableMint(position.mint) || !(position.hasLiquidity ?? true)) {
      continue;
    }

    const key = activeLpKey(position);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    positions.push(position);
  }

  return positions;
}

function findMatchingRecord(
  records: PositionLedgerRecord[],
  position: AccountLpPosition
) {
  const chainPositionAddress = position.chainPositionAddress || position.positionAddress;
  if (chainPositionAddress) {
    return records.find((record) =>
      record.chainPositionAddress === chainPositionAddress ||
      record.positionId === chainPositionAddress ||
      record.positionKey === `chain-position:${chainPositionAddress}`
    );
  }

  if (position.positionId) {
    return records.find((record) =>
      record.lifecycleState !== 'closed' &&
      (record.positionId === position.positionId || record.positionKey === `position:${position.positionId}`)
    );
  }

  return undefined;
}

function findPendingOpenRecordForObservedPosition(
  records: PositionLedgerRecord[],
  pendingSubmission: PendingSubmissionSnapshot | null | undefined,
  pendingMatchesPosition: boolean
) {
  if (!pendingSubmission || !pendingMatchesPosition) {
    return undefined;
  }

  return records.find((record) =>
    record.lifecycleState !== 'closed' &&
    record.lifecycleState !== 'failed_terminal' &&
    !record.chainPositionAddress &&
    (
      (pendingSubmission.idempotencyKey && record.idempotencyKey === pendingSubmission.idempotencyKey) ||
      (pendingSubmission.openIntentId && record.openIntentId === pendingSubmission.openIntentId)
    )
  );
}

function findTrustedFillRecordForObservedPosition(
  records: PositionLedgerRecord[],
  entryFillSubmissionId?: string
) {
  if (!entryFillSubmissionId) {
    return undefined;
  }

  return records.find((record) =>
    record.lifecycleState !== 'closed'
    && record.lifecycleState !== 'failed_terminal'
    && !record.chainPositionAddress
    && record.entryFillSubmissionId === entryFillSubmissionId
  );
}

function pendingOpenUniquelyBindsPosition(input: {
  pendingSubmission?: PendingSubmissionSnapshot | null;
  position: AccountLpPosition;
  activePositions: AccountLpPosition[];
}) {
  const pending = input.pendingSubmission;
  if (
    !pending
    || pending.confirmationStatus === 'failed'
    || (pending.orderAction && pending.orderAction !== 'add-lp')
    || !pending.idempotencyKey
  ) {
    return false;
  }

  const chainPositionAddress = input.position.chainPositionAddress || input.position.positionAddress;
  if (pending.chainPositionAddress) {
    return Boolean(chainPositionAddress && pending.chainPositionAddress === chainPositionAddress);
  }

  const hasPoolEvidence = Boolean(pending.poolAddress);
  const hasMintEvidence = Boolean(pending.tokenMint);
  if (!hasPoolEvidence && !hasMintEvidence) {
    return false;
  }

  const matches = input.activePositions.filter((position) =>
    (!hasPoolEvidence || position.poolAddress === pending.poolAddress)
    && (!hasMintEvidence || position.mint === pending.tokenMint)
  );
  return matches.length === 1 && matches[0] === input.position;
}

function resolveEntryFromFills(input: {
  position: AccountLpPosition;
  accountState?: LiveAccountState;
}) {
  const chainPositionAddress = input.position.chainPositionAddress || input.position.positionAddress;
  const fills = [...(input.accountState?.fills ?? [])].reverse();
  const fill = fills.find((entry) =>
    isTrustedLpOpenFill(entry) &&
    Boolean(entry.submissionId) &&
    entry.mint === input.position.mint &&
    Boolean(chainPositionAddress) &&
    (
      entry.chainPositionAddress === chainPositionAddress ||
      entry.positionId === chainPositionAddress
    )
  );

  const entrySol = typeof fill?.actualFilledSol === 'number' && fill.actualFilledSol > 0
    ? fill.actualFilledSol
    : typeof (fill as any)?.filledSol === 'number' && (fill as any).filledSol > 0
      ? (fill as any).filledSol
      : typeof fill?.amount === 'number' && fill.amount > 0
        ? fill.amount
        : undefined;

  return entrySol
    ? {
        entrySol,
        entrySolSource: fill?.fillAmountSource === 'chain-reconstructed'
          ? 'reconstructed_chain' as const
          : 'actual_fill' as const,
        entryFillSubmissionId: fill?.submissionId,
        openedAt: fill?.recordedAt
      }
    : undefined;
}

function recordsShareClosedLifecycleIdentity(record: PositionLedgerRecord, chainRecord: PositionLedgerRecord) {
  if (record === chainRecord || !chainRecord.chainPositionAddress || record.chainPositionAddress) {
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

  if (
    !record.missingOnChainSince ||
    !chainRecord.lastClosedAt ||
    !record.activePoolAddress ||
    !record.activeMint ||
    record.activePoolAddress !== chainRecord.activePoolAddress ||
    record.activeMint !== chainRecord.activeMint
  ) {
    return false;
  }

  const recordOpenedAtMs = record.openedAt ? Date.parse(record.openedAt) : Number.NaN;
  const chainClosedAtMs = Date.parse(chainRecord.lastClosedAt);
  return Number.isFinite(recordOpenedAtMs) && Number.isFinite(chainClosedAtMs)
    ? recordOpenedAtMs <= chainClosedAtMs
    : false;
}

function pendingSubmissionMatchesSyntheticOpen(
  record: PositionLedgerRecord,
  pendingSubmission?: PendingSubmissionSnapshot | null
) {
  if (
    !pendingSubmission ||
    pendingSubmission.confirmationStatus === 'failed' ||
    (pendingSubmission.orderAction !== 'add-lp' && pendingSubmission.orderAction !== 'deploy')
  ) {
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

function normalizeLedgerLifecycleRecords(
  records: PositionLedgerRecord[],
  now: string,
  pendingSubmission?: PendingSubmissionSnapshot | null
) {
  const closedChainRecords = records.filter((record) =>
    record.lifecycleState === 'closed' && Boolean(record.chainPositionAddress)
  );
  const nowMs = Date.parse(now);

  return records.map((record) => {
    if (record.lifecycleState === 'closed' || record.importStatus === 'superseded_closed') {
      return record;
    }

    // A large-pool spot record is evidenced by its exact owned wallet-token
    // quantity, not by an LP position address.
    if (record.ownedTokenAmountRaw) {
      return record;
    }

    const supersedingRecord = closedChainRecords.find((chainRecord) =>
      recordsShareClosedLifecycleIdentity(record, chainRecord)
    );
    if (supersedingRecord) {
      return {
        ...record,
        lifecycleState: 'closed' as const,
        importStatus: 'superseded_closed' as const,
        supersededByPositionKey: supersedingRecord.positionKey,
        lastAction: 'withdraw-lp',
        lastReason: 'superseded-by-chain-closed-position',
        evidenceMissingReason: record.evidenceMissingReason ?? record.lastReason,
        missingOnChainSince: record.missingOnChainSince ?? now,
        lastClosedAt: record.lastClosedAt ?? supersedingRecord.lastClosedAt ?? now,
        updatedAt: now
      };
    }

    const openedAtMs = record.openedAt ? Date.parse(record.openedAt) : Number.NaN;
    const stillWithinChainEvidenceGrace = record.lastAction === 'add-lp'
      && Boolean(record.entryFillSubmissionId)
      && Number.isFinite(openedAtMs)
      && Number.isFinite(nowMs)
      && nowMs - openedAtMs < CHAIN_POSITION_EVIDENCE_GRACE_MS;
    if (
      record.lifecycleState === 'reconcile_required'
      && !record.chainPositionAddress
      && stillWithinChainEvidenceGrace
    ) {
      return {
        ...record,
        lifecycleState: 'open_pending' as const,
        lastReason: 'awaiting-chain-position-evidence',
        missingOnChainSince: undefined,
        updatedAt: now
      };
    }

    if (
      record.lifecycleState === 'open_pending'
      && !record.chainPositionAddress
      && record.lastAction === 'add-lp'
      && record.lastReason === 'awaiting-chain-position-evidence'
      && record.entryFillSubmissionId
    ) {
      if (pendingSubmissionMatchesSyntheticOpen(record, pendingSubmission) || stillWithinChainEvidenceGrace) {
        return {
          ...record,
          lifecycleState: 'open_pending' as const,
          lastReason: 'awaiting-chain-position-evidence',
          missingOnChainSince: undefined,
          updatedAt: now
        };
      }

      return {
        ...record,
        lifecycleState: 'reconcile_required' as const,
        importStatus: 'archived_missing_without_exit_evidence' as const,
        lastReason: 'chain-position-evidence-timeout',
        evidenceMissingReason: record.evidenceMissingReason ?? 'submitted-open-without-chain-position-after-grace',
        missingOnChainSince: record.missingOnChainSince ?? now,
        updatedAt: now
      };
    }

    const syntheticOpenWithoutChainEvidence = record.lifecycleState === 'open'
      && !record.chainPositionAddress
      && (
        Boolean(record.missingOnChainSince)
        || record.importStatus === 'archived_missing_without_exit_evidence'
        || record.lastReason === 'chain-position-missing-without-exit-evidence'
      );
    if (syntheticOpenWithoutChainEvidence) {
      if (stillWithinChainEvidenceGrace) {
        return {
          ...record,
          lifecycleState: 'open_pending' as const,
          lastReason: 'awaiting-chain-position-evidence',
          missingOnChainSince: undefined,
          updatedAt: now
        };
      }

      const isTerminalFailedAttempt = !record.entrySol;
      return {
        ...record,
        lifecycleState: isTerminalFailedAttempt ? 'failed_terminal' as const : 'reconcile_required' as const,
        importStatus: 'archived_missing_without_exit_evidence' as const,
        lastReason: isTerminalFailedAttempt
          ? record.lastReason ?? 'synthetic-open-without-chain-evidence'
          : 'synthetic-open-missing-chain-evidence',
        evidenceMissingReason: record.evidenceMissingReason ?? record.lastReason ?? 'synthetic-open-without-chain-identity',
        missingOnChainSince: record.missingOnChainSince ?? now,
        lastClosedAt: isTerminalFailedAttempt ? record.lastClosedAt ?? now : record.lastClosedAt,
        updatedAt: now
      };
    }

    return record;
  });
}

export function migratePositionStateToLedger(input: {
  positionState?: PositionStateSnapshot | null;
  now: string;
}): PositionLedgerSnapshot {
  const state = input.positionState;
  if (!state || state.lifecycleState === 'closed' || (!state.activeMint && !state.activePoolAddress && !state.chainPositionAddress)) {
    return {
      version: 1,
      records: [],
      updatedAt: input.now
    };
  }

  return {
    version: 1,
    updatedAt: input.now,
    records: [{
      positionKey: positionLedgerKey({
        chainPositionAddress: state.chainPositionAddress,
        positionId: state.positionId,
        openIntentId: state.openIntentId,
        idempotencyKey: state.lastOrderIdempotencyKey,
        poolAddress: state.activePoolAddress,
        mint: state.activeMint
      }),
      openIntentId: state.openIntentId,
      idempotencyKey: state.lastOrderIdempotencyKey,
      positionId: state.positionId,
      chainPositionAddress: state.chainPositionAddress,
      activeMint: state.activeMint,
      activePoolAddress: state.activePoolAddress,
      lifecycleState: state.lifecycleState ?? 'open',
      ownedTokenAmountRaw: state.ownedTokenAmountRaw,
      entrySol: state.entrySol,
      entrySolSource: state.entrySolSource,
      entryFillSubmissionId: state.entryFillSubmissionId,
      openedAt: state.openedAt,
      importStatus: state.entrySol ? 'imported' : 'entry_unknown',
      lastAction: state.lastAction,
      lastReason: state.lastReason,
      valuationStatus: state.valuationStatus,
      valuationReason: state.valuationReason,
      valuationTrust: state.valuationTrust,
      valuationSource: state.valuationSource,
      valuationCompleteness: state.valuationCompleteness,
      exitQuoteValueSol: state.exitQuoteValueSol,
      marketValueSol: state.marketValueSol,
      displayValueSol: state.displayValueSol,
      lpTotalValueSol: state.lpTotalValueSol,
      lastValuationAt: state.lastValuationAt,
      lastClosedAt: state.lastClosedAt,
      updatedAt: state.updatedAt || input.now
    }]
  };
}

export function importActiveLpPositionsToLedger(input: {
  ledger?: PositionLedgerSnapshot | null;
  positionState?: PositionStateSnapshot | null;
  accountState?: LiveAccountState;
  pendingSubmission?: PendingSubmissionSnapshot | null;
  closeMissingActive?: boolean;
  updateRiskSentinel?: boolean;
  now: string;
}): PositionLedgerSnapshot {
  const baseLedger = input.ledger ?? migratePositionStateToLedger({
    positionState: input.positionState,
    now: input.now
  });
  const records = [...baseLedger.records];
  const activeKeys = new Set<string>();
  const activePositions = collectActiveLpPositions(input.accountState);

  for (const position of activePositions) {
    const chainPositionAddress = position.chainPositionAddress || position.positionAddress;
    const key = positionLedgerKey({
      chainPositionAddress,
      positionId: position.positionId,
      poolAddress: position.poolAddress,
      mint: position.mint
    });
    activeKeys.add(key);

    const pendingMatchesPosition = pendingOpenUniquelyBindsPosition({
      pendingSubmission: input.pendingSubmission,
      position,
      activePositions
    });
    const resolvedFillEntry = resolveEntryFromFills({
      position,
      accountState: input.accountState
    });
    const existing = findMatchingRecord(records, position)
      ?? findTrustedFillRecordForObservedPosition(
        records,
        resolvedFillEntry?.entryFillSubmissionId
      )
      ?? findPendingOpenRecordForObservedPosition(
        records,
        input.pendingSubmission,
        pendingMatchesPosition
      );
    if (existing?.lifecycleState === 'closed' && existing.chainPositionAddress === chainPositionAddress) {
      continue;
    }
    const existingEntryMatchesPosition = Boolean(
      existing
      && existing.entrySol
      && (
        !existing.chainPositionAddress
        || existing.chainPositionAddress === chainPositionAddress
      )
    );
    const existingEntry = existing && existingEntryMatchesPosition
      ? {
          entrySol: existing.entrySol,
          entrySolSource: existing.entrySolSource,
          entryFillSubmissionId: existing.entryFillSubmissionId,
          openedAt: existing.openedAt
        }
      : undefined;
    const positionStateEntryMatchesPosition = Boolean(
      input.positionState
      && input.positionState.entrySol
      && positionStateOwnsLpPosition(position, input.positionState)
    );
    const positionStateEntry = positionStateEntryMatchesPosition
      ? {
          entrySol: input.positionState?.entrySol,
          entrySolSource: input.positionState?.entrySolSource,
          entryFillSubmissionId: input.positionState?.entryFillSubmissionId,
          openedAt: input.positionState?.openedAt
        }
      : undefined;
    const entry = resolvedFillEntry ?? positionStateEntry ?? existingEntry;
    const hasTrustedEntry = typeof entry?.entrySol === 'number'
      && entry.entrySol > 0
      && isTrustedEntrySolSource(entry.entrySolSource);
    const hasOwnershipEvidence = hasLightldLpOwnershipEvidence({
      position,
      ledgerRecord: existing,
      positionState: input.positionState,
      pendingSubmission: input.pendingSubmission,
      pendingOpenBound: pendingMatchesPosition,
      trustedOpenFillBound: Boolean(resolvedFillEntry?.entryFillSubmissionId)
    });
    const existingReasonIsOwnershipFailure = existing?.lastReason === UNBOUND_ACCOUNT_LP_REASON;
    const nextRecord: PositionLedgerRecord = {
      ...(existing ?? {
        lastAction: 'hold'
      }),
      positionKey: key,
      positionId: chainPositionAddress
        ? createPositionId({ chainPositionAddress })
        : position.positionId ?? existing?.positionId,
      openIntentId: existing?.openIntentId ?? (pendingMatchesPosition ? input.pendingSubmission?.openIntentId : undefined),
      idempotencyKey: existing?.idempotencyKey ?? (pendingMatchesPosition ? input.pendingSubmission?.idempotencyKey : undefined),
      chainPositionAddress,
      activeMint: position.mint,
      activePoolAddress: position.poolAddress,
      lifecycleState: hasOwnershipEvidence ? 'open' : 'reconcile_required',
      entrySol: entry?.entrySol,
      entrySolSource: entry?.entrySolSource,
      entryFillSubmissionId: entry?.entryFillSubmissionId,
      openedAt: entry?.openedAt ?? existing?.openedAt,
      importStatus: hasTrustedEntry ? 'imported' : 'entry_unknown',
      lastReason: hasOwnershipEvidence
        ? (existingReasonIsOwnershipFailure ? 'lp-ownership-evidence-recovered' : existing?.lastReason)
        : UNBOUND_ACCOUNT_LP_REASON,
      evidenceMissingReason: hasOwnershipEvidence
        ? (existingReasonIsOwnershipFailure ? undefined : existing?.evidenceMissingReason)
        : 'missing-open-intent-idempotency-or-entry-fill',
      valuationStatus: hasTrustedEntry
        ? position.valuationStatus as PositionLedgerRecord['valuationStatus']
        : 'unavailable',
      valuationReason: hasTrustedEntry
        ? position.valuationReason
        : 'orphaned-position-without-bound-entry',
      valuationTrust: hasTrustedEntry ? position.valuationTrust : undefined,
      valuationSource: hasTrustedEntry ? position.valuationSource : undefined,
      valuationCompleteness: hasTrustedEntry ? position.valuationCompleteness : undefined,
      exitQuoteValueSol: hasTrustedEntry ? position.currentValueSol : undefined,
      displayValueSol: hasTrustedEntry ? position.currentValueSol : undefined,
      lpTotalValueSol: hasTrustedEntry ? position.currentValueSol : undefined,
      lastValuationAt: hasTrustedEntry ? position.lastValuationAt : undefined,
      lastRiskSentinel: input.updateRiskSentinel === false && existing?.lastRiskSentinel
        ? existing.lastRiskSentinel
        : evaluateLpRiskSentinel({
            observedAt: input.now,
            activeBinId: position.activeBinId,
            lowerBinId: position.lowerBinId,
            upperBinId: position.upperBinId,
            solDepletedBins: position.solDepletedBins,
            binCount: position.binCount,
            currentValueSol: position.currentValueSol,
            liquidityValueSol: position.liquidityValueSol,
            currentPrice: position.currentPrice,
            previous: existing?.lastRiskSentinel
          }),
      firstSeenOnChainAt: existing?.firstSeenOnChainAt ?? input.now,
      lastSeenOnChainAt: input.now,
      missingOnChainSince: undefined,
      updatedAt: input.now
    };

    const existingIndex = records.findIndex((record) => record.positionKey === existing?.positionKey || record.positionKey === key);
    if (existingIndex >= 0) {
      records[existingIndex] = nextRecord;
    } else {
      records.push(nextRecord);
    }

    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (
        record.positionKey === nextRecord.positionKey ||
        record.chainPositionAddress ||
        record.lifecycleState === 'closed' ||
        record.lifecycleState === 'failed_terminal' ||
        record.importStatus === 'superseded_closed'
      ) {
        continue;
      }

      const sharesPendingIdentity =
        (nextRecord.idempotencyKey && record.idempotencyKey === nextRecord.idempotencyKey) ||
        (nextRecord.openIntentId && record.openIntentId === nextRecord.openIntentId);
      const sharesTrustedFillIdentity = Boolean(
        nextRecord.entryFillSubmissionId
        && record.entryFillSubmissionId === nextRecord.entryFillSubmissionId
      );
      if (!sharesPendingIdentity && !sharesTrustedFillIdentity) {
        continue;
      }

      records[i] = {
        ...record,
        lifecycleState: 'closed',
        importStatus: 'superseded_closed',
        supersededByPositionKey: nextRecord.positionKey,
        lastReason: 'superseded-by-chain-position',
        updatedAt: input.now
      };
    }
  }

  const accountObservationIsComplete = Boolean(
    input.accountState?.observedAt
    && Array.isArray(input.accountState.walletLpPositions)
    && Array.isArray(input.accountState.journalLpPositions)
    && Array.isArray(input.accountState.walletTokens)
    && Array.isArray(input.accountState.journalTokens)
    && Array.isArray(input.accountState.fills)
  );
  const accountObservedAtMs = input.accountState?.observedAt
    ? Date.parse(input.accountState.observedAt)
    : Number.NaN;
  const shouldCloseMissing = input.closeMissingActive === true
    && !input.pendingSubmission
    && accountObservationIsComplete
    && Number.isFinite(accountObservedAtMs);
  const isTerminalExitRecord = (record: PositionLedgerRecord) =>
    record.lastAction === 'withdraw-lp' ||
    record.pendingOrderAction === 'withdraw-lp' ||
    record.lifecycleState === 'lp_exit_pending' ||
    record.lifecycleState === 'inventory_exit_ready';
  const nextRecords = records.map((record) => {
    if (record.lifecycleState === 'closed') {
      return record;
    }

    if (record.ownedTokenAmountRaw) {
      if (!input.accountState) {
        return record;
      }
      const observedRaw = walletTokenAmountRaw(input.accountState, record.activeMint);
      const ownedRaw = BigInt(record.ownedTokenAmountRaw);
      if (observedRaw === undefined || observedRaw < ownedRaw) {
        return {
          ...record,
          lifecycleState: 'reconcile_required' as const,
          lastReason: observedRaw === undefined
            ? 'spot-ownership-reconcile-required:wallet-token-raw-unavailable'
            : 'spot-ownership-reconcile-required:wallet-balance-below-owned-amount',
          evidenceMissingReason: observedRaw === undefined
            ? 'wallet-token-raw-unavailable'
            : 'wallet-balance-below-owned-amount',
          updatedAt: input.now
        };
      }
      return {
        ...record,
        missingOnChainSince: undefined,
        updatedAt: input.now
      };
    }

    if (
      record.lifecycleState === 'reconcile_required'
      && (
        record.lastAction === 'deploy'
        || record.lastReason?.startsWith('spot-ownership-reconcile-required:')
      )
    ) {
      // A large-pool spot position intentionally has no chain LP address.
      // Do not reinterpret its explicit ownership reconciliation as missing
      // LP evidence during the generic closeMissingActive import pass.
      return {
        ...record,
        updatedAt: input.now
      };
    }

    const recordKey = positionLedgerKey({
      chainPositionAddress: record.chainPositionAddress,
      positionId: record.positionId,
      poolAddress: record.activePoolAddress,
      mint: record.activeMint
    });

    if (record.chainPositionAddress && activeKeys.has(recordKey)) {
      return record;
    }

    if (isSubmittedPendingOpenRecord(record, input.pendingSubmission, { now: input.now })) {
      return {
        ...record,
        missingOnChainSince: undefined,
        updatedAt: input.now
      };
    }

    const isUnprovenPendingOpenRecord = record.lifecycleState === 'open_pending'
      && !record.chainPositionAddress;
    if (isUnprovenPendingOpenRecord) {
      const openedAtMs = record.openedAt ? Date.parse(record.openedAt) : Number.NaN;
      const nowMs = Date.parse(input.now);
      const stillWithinChainEvidenceGrace = record.lastAction === 'add-lp'
        && Boolean(record.entryFillSubmissionId)
        && Number.isFinite(openedAtMs)
        && Number.isFinite(nowMs)
        && nowMs - openedAtMs < CHAIN_POSITION_EVIDENCE_GRACE_MS;
      if (stillWithinChainEvidenceGrace) {
        return {
          ...record,
          lifecycleState: 'open_pending' as const,
          lastReason: 'awaiting-chain-position-evidence',
          missingOnChainSince: undefined,
          updatedAt: input.now
        };
      }

      const isTerminalFailedAttempt = record.lastReason === 'http-400'
        || record.lastReason === 'sign-failed'
        || record.lastReason === 'not-submitted'
        || record.lastReason === 'broadcast-not-submitted'
        || record.lastReason === 'chain-position-missing-without-exit-evidence'
        || Boolean(record.missingOnChainSince);
      const isChainEvidenceTimeout = record.lastAction === 'add-lp'
        && record.lastReason === 'awaiting-chain-position-evidence'
        && Boolean(record.entryFillSubmissionId);
      return {
        ...record,
        lifecycleState: isTerminalFailedAttempt ? 'failed_terminal' as const : 'reconcile_required' as const,
        importStatus: 'archived_missing_without_exit_evidence' as const,
        lastReason: isTerminalFailedAttempt
          ? record.lastReason
          : isChainEvidenceTimeout
            ? 'chain-position-evidence-timeout'
            : 'open-pending-without-chain-evidence',
        evidenceMissingReason: isChainEvidenceTimeout
          ? record.evidenceMissingReason ?? 'submitted-open-without-chain-position-after-grace'
          : record.evidenceMissingReason,
        missingOnChainSince: record.missingOnChainSince ?? input.now,
        lastClosedAt: isTerminalFailedAttempt ? record.lastClosedAt ?? input.now : record.lastClosedAt,
        updatedAt: input.now
      };
    }

    const isUnprovenSyntheticOpenRecord = record.lifecycleState === 'open'
      && !record.chainPositionAddress
      && !record.entrySol;
    if (isUnprovenSyntheticOpenRecord) {
      return {
        ...record,
        lifecycleState: 'failed_terminal' as const,
        importStatus: 'archived_missing_without_exit_evidence' as const,
        lastReason: record.lastReason ?? 'synthetic-open-without-chain-evidence',
        missingOnChainSince: record.missingOnChainSince ?? input.now,
        lastClosedAt: record.lastClosedAt ?? input.now,
        updatedAt: input.now
      };
    }

    const exitAttemptedAtMs = Date.parse(
      record.lastExitAttemptAt ?? record.updatedAt
    );
    const hasFreshClosureObservation = shouldCloseMissing
      && Number.isFinite(exitAttemptedAtMs)
      && accountObservedAtMs > exitAttemptedAtMs;
    if (!hasFreshClosureObservation || !isTerminalExitRecord(record)) {
      return {
        ...record,
        lifecycleState: record.lifecycleState,
        importStatus: input.closeMissingActive === true
          ? 'archived_missing_without_exit_evidence' as const
          : record.importStatus,
        lastReason: input.closeMissingActive === true
          ? 'chain-position-missing-without-exit-evidence'
          : record.lastReason,
        missingOnChainSince: record.missingOnChainSince ?? input.now,
        lastClosedAt: record.lastClosedAt,
        updatedAt: input.now
      };
    }

    return {
      ...record,
      lifecycleState: 'closed' as const,
      lastAction: record.lastAction || 'withdraw-lp',
      lastReason: record.lastReason || 'chain-position-not-active',
      lastClosedAt: input.now,
      updatedAt: input.now
    };
  });

  return {
    version: 1,
    records: normalizeLedgerLifecycleRecords(nextRecords, input.now, input.pendingSubmission),
    updatedAt: input.now
  };
}

function recordMatchesTarget(input: {
  record: PositionLedgerRecord;
  chainPositionAddress?: string;
  positionId?: string;
  openIntentId?: string;
  idempotencyKey?: string;
  poolAddress?: string;
  tokenMint?: string;
}) {
  if (input.chainPositionAddress) {
    return input.record.chainPositionAddress === input.chainPositionAddress
      || input.record.positionId === input.chainPositionAddress
      || input.record.positionKey === `chain-position:${input.chainPositionAddress}`;
  }

  if (input.openIntentId) {
    return input.record.openIntentId === input.openIntentId || input.record.positionKey === `open-intent:${input.openIntentId}`;
  }

  if (input.idempotencyKey) {
    return input.record.idempotencyKey === input.idempotencyKey || input.record.positionKey === `idempotency:${input.idempotencyKey}`;
  }

  if (input.record.lifecycleState === 'closed' || input.record.importStatus === 'superseded_closed') {
    return false;
  }

  if (input.positionId) {
    return input.record.positionId === input.positionId || input.record.positionKey === `position:${input.positionId}`;
  }

  return Boolean(
    input.poolAddress &&
    input.tokenMint &&
    input.record.activePoolAddress === input.poolAddress &&
    input.record.activeMint === input.tokenMint
  );
}

function hasActivePositionForRecord(input: {
  record: PositionLedgerRecord;
  accountState?: LiveAccountState;
}) {
  return collectActiveLpPositions(input.accountState).some((position) =>
    recordMatchesTarget({
      record: input.record,
      chainPositionAddress: position.chainPositionAddress || position.positionAddress,
      positionId: position.positionId,
      poolAddress: position.poolAddress,
      tokenMint: position.mint
    })
  );
}

export function applyLiveCycleResultToLedger(input: {
  ledger?: PositionLedgerSnapshot | null;
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot | null;
  pendingSubmissionBeforeCycle?: PendingSubmissionSnapshot | null;
  persistedPendingSubmission?: PendingSubmissionSnapshot | null;
  actionIdentity?: {
    openIntentId?: string;
    positionId?: string;
    chainPositionAddress?: string;
  };
  orderIntent?: {
    idempotencyKey?: string;
    poolAddress?: string;
    tokenMint?: string;
    inputAmountRaw?: string;
  };
  action: string;
  reason: string;
  exitTriggerReason?: string;
  liveOrderSubmitted: boolean;
  confirmationStatus?: string;
  finality?: string;
  exitActionClosureProven?: boolean;
  fullExitClosureProven?: boolean;
  residualCleanupStatus?: string;
  residualCleanupValueSol?: number;
  residualCleanupAmountRaw?: string;
  confirmedFill?: {
    submissionId: string;
    actualFilledSol?: number;
    filledSol: number;
    acquiredTokenAmountRaw?: string;
    fillAmountSource?: string;
    recordedAt: string;
  };
  now: string;
}): PositionLedgerSnapshot {
  const imported = importActiveLpPositionsToLedger({
    ledger: input.ledger,
    positionState: input.positionState,
    accountState: input.accountState,
    pendingSubmission: input.persistedPendingSubmission ?? input.pendingSubmissionBeforeCycle,
    updateRiskSentinel: false,
    now: input.now
  });

  const actionChainPositionAddress = input.actionIdentity?.chainPositionAddress;
  const actionPoolAddress = input.orderIntent?.poolAddress;
  const actionTokenMint = input.orderIntent?.tokenMint;
  const pendingOrderAction = input.persistedPendingSubmission?.orderAction
    ?? input.pendingSubmissionBeforeCycle?.orderAction;
  const positionStateMatchesTarget = Boolean(input.positionState && (
    (actionChainPositionAddress && input.positionState.chainPositionAddress === actionChainPositionAddress)
    || (
      actionPoolAddress
      && actionTokenMint
      && input.positionState.activePoolAddress === actionPoolAddress
      && input.positionState.activeMint === actionTokenMint
    )
    || (!actionChainPositionAddress && !actionPoolAddress && !actionTokenMint)
  ));
  const persistedPendingMatchesTarget = Boolean(input.persistedPendingSubmission && (
    (actionChainPositionAddress && input.persistedPendingSubmission.chainPositionAddress === actionChainPositionAddress)
    || (
      actionPoolAddress
      && actionTokenMint
      && input.persistedPendingSubmission.poolAddress === actionPoolAddress
      && input.persistedPendingSubmission.tokenMint === actionTokenMint
    )
    || (!actionChainPositionAddress && !actionPoolAddress && !actionTokenMint)
  ));
  const priorPendingMatchesTarget = Boolean(input.pendingSubmissionBeforeCycle && (
    (actionChainPositionAddress && input.pendingSubmissionBeforeCycle.chainPositionAddress === actionChainPositionAddress)
    || (
      actionPoolAddress
      && actionTokenMint
      && input.pendingSubmissionBeforeCycle.poolAddress === actionPoolAddress
      && input.pendingSubmissionBeforeCycle.tokenMint === actionTokenMint
    )
    || (!actionChainPositionAddress && !actionPoolAddress && !actionTokenMint)
  ));

  const target = {
    chainPositionAddress: input.actionIdentity?.chainPositionAddress
      ?? (persistedPendingMatchesTarget ? input.persistedPendingSubmission?.chainPositionAddress : undefined)
      ?? (priorPendingMatchesTarget ? input.pendingSubmissionBeforeCycle?.chainPositionAddress : undefined)
      ?? (positionStateMatchesTarget ? input.positionState?.chainPositionAddress : undefined),
    positionId: input.actionIdentity?.positionId
      ?? (persistedPendingMatchesTarget ? input.persistedPendingSubmission?.positionId : undefined)
      ?? (priorPendingMatchesTarget ? input.pendingSubmissionBeforeCycle?.positionId : undefined)
      ?? (positionStateMatchesTarget ? input.positionState?.positionId : undefined),
    openIntentId: input.actionIdentity?.openIntentId
      ?? (persistedPendingMatchesTarget ? input.persistedPendingSubmission?.openIntentId : undefined)
      ?? (priorPendingMatchesTarget ? input.pendingSubmissionBeforeCycle?.openIntentId : undefined)
      ?? (positionStateMatchesTarget ? input.positionState?.openIntentId : undefined),
    idempotencyKey: input.orderIntent?.idempotencyKey
      ?? input.persistedPendingSubmission?.idempotencyKey
      ?? input.pendingSubmissionBeforeCycle?.idempotencyKey,
    poolAddress: input.orderIntent?.poolAddress
      ?? input.persistedPendingSubmission?.poolAddress
      ?? input.pendingSubmissionBeforeCycle?.poolAddress
      ?? input.positionState?.activePoolAddress,
    tokenMint: input.orderIntent?.tokenMint
      ?? input.persistedPendingSubmission?.tokenMint
      ?? input.pendingSubmissionBeforeCycle?.tokenMint
      ?? input.positionState?.activeMint
  };

  if (
    !input.liveOrderSubmitted &&
    !input.persistedPendingSubmission &&
    !input.pendingSubmissionBeforeCycle &&
    (
      input.action === 'add-lp' ||
      (!input.actionIdentity && !input.orderIntent)
    )
  ) {
    return imported;
  }

  const records = [...imported.records];
  if (
    input.action === 'dca-out'
    && input.fullExitClosureProven === true
    && actionTokenMint
    && input.orderIntent?.inputAmountRaw
    && /^\d+$/.test(input.orderIntent.inputAmountRaw)
  ) {
    const matchingResidualIndexes = records
      .map((record, recordIndex) => ({ record, recordIndex }))
      .filter(({ record }) =>
        record.activeMint === actionTokenMint
        && record.residualCleanupStatus === 'residual_cleanup_pending'
        && Boolean(record.residualCleanupAmountRaw && /^\d+$/.test(record.residualCleanupAmountRaw))
      );
    const expectedResidualRaw = matchingResidualIndexes.reduce(
      (total, { record }) => total + BigInt(record.residualCleanupAmountRaw!),
      0n
    );
    if (
      matchingResidualIndexes.length > 0
      && expectedResidualRaw === BigInt(input.orderIntent.inputAmountRaw)
    ) {
      for (const { record, recordIndex } of matchingResidualIndexes) {
        records[recordIndex] = {
          ...record,
          lifecycleState: 'closed',
          lastAction: 'dca-out',
          lastReason: input.exitTriggerReason ?? input.reason,
          lastOrderIdempotencyKey: input.orderIntent.idempotencyKey ?? record.lastOrderIdempotencyKey,
          lastExitAttemptAt: input.now,
          exitAttemptCount: (record.exitAttemptCount ?? 0) + 1,
          residualCleanupStatus: 'residual_cleanup_complete',
          residualCleanupAmountRaw: undefined,
          lastClosedAt: record.lastClosedAt ?? input.now,
          updatedAt: input.now
        };
      }
      return {
        version: 1,
        records: normalizeLedgerLifecycleRecords(
          records,
          input.now,
          input.persistedPendingSubmission ?? input.pendingSubmissionBeforeCycle
        ),
        updatedAt: input.now
      };
    }
  }
  let index = records.findIndex((record) => recordMatchesTarget({ record, ...target }));
  const shouldCreateTargetRecord = Boolean(
    input.liveOrderSubmitted
    || input.persistedPendingSubmission
    || input.pendingSubmissionBeforeCycle
    || input.actionIdentity
  );
  if (
    index < 0
    && shouldCreateTargetRecord
    && (input.action === 'add-lp' || target.poolAddress || target.tokenMint || target.openIntentId || target.idempotencyKey)
  ) {
    records.push({
      positionKey: positionLedgerKey({
        chainPositionAddress: target.chainPositionAddress,
        positionId: target.chainPositionAddress || !target.openIntentId ? target.positionId : undefined,
        openIntentId: target.openIntentId,
        idempotencyKey: target.idempotencyKey,
        poolAddress: target.poolAddress,
        mint: target.tokenMint
      }),
      openIntentId: target.openIntentId,
      idempotencyKey: target.idempotencyKey,
      positionId: target.positionId,
      chainPositionAddress: target.chainPositionAddress,
      activeMint: target.tokenMint,
      activePoolAddress: target.poolAddress,
      lifecycleState: input.action === 'add-lp' || input.action === 'deploy'
        || pendingOrderAction === 'add-lp' || pendingOrderAction === 'deploy'
        ? 'open_pending'
        : input.action === 'dca-out' || pendingOrderAction === 'dca-out'
          ? 'inventory_exit_pending'
          : 'lp_exit_pending',
      importStatus: 'entry_unknown',
      lastAction: input.action,
      lastReason: input.reason,
      updatedAt: input.now
    });
    index = records.length - 1;
  }

  if (index < 0) {
    return imported;
  }

  const record = records[index];
  const spotExit = (input.action === 'dca-out' || pendingOrderAction === 'dca-out')
    && Boolean(record.ownedTokenAmountRaw);
  if (input.action === 'dca-out' && !spotExit) {
    // A dca-out after an LP withdrawal is residual cleanup owned by the LP
    // record's residual fields. The aggregate residual branch above updates
    // those records only when exact closure proof is present.
    return imported;
  }
  const hasPending = Boolean(input.persistedPendingSubmission);
  const partialBatch = input.persistedPendingSubmission?.batchStatus === 'partial'
    || input.pendingSubmissionBeforeCycle?.batchStatus === 'partial';
  const isConfirmed = input.confirmationStatus === 'confirmed';
  const fullExit = input.action === 'withdraw-lp'
    || pendingOrderAction === 'withdraw-lp'
    || spotExit;
  const stillOnChain = hasActivePositionForRecord({
    record,
    accountState: input.accountState
  });
  const terminalAlreadyClosed = fullExit
    && (input.reason.includes('position-already-closed') || /position not found for pool/i.test(input.reason))
    && !stillOnChain;
  if (
    record.lifecycleState === 'closed'
    && terminalAlreadyClosed
    && !input.liveOrderSubmitted
  ) {
    return {
      version: 1,
      records: normalizeLedgerLifecycleRecords(records, input.now, input.persistedPendingSubmission ?? input.pendingSubmissionBeforeCycle),
      updatedAt: input.now
    };
  }
  const confirmedSpotOpen = input.action === 'deploy' && isConfirmed;
  const lifecycleState = confirmedSpotOpen && !input.confirmedFill?.acquiredTokenAmountRaw
    ? 'reconcile_required'
    : fullExit
      && !partialBatch
      && !hasPending
      && (
        input.fullExitClosureProven === true
        || input.exitActionClosureProven === true
        || terminalAlreadyClosed
      )
    ? 'closed'
    : fullExit && (hasPending || isConfirmed)
      ? spotExit ? 'inventory_exit_pending' : 'lp_exit_pending'
    : hasPending && (
      input.action === 'add-lp' || pendingOrderAction === 'add-lp'
      || input.action === 'deploy' || pendingOrderAction === 'deploy'
    )
      ? 'open_pending'
      : isConfirmed && (input.action === 'add-lp' || input.action === 'deploy')
        ? input.action === 'deploy' || target.chainPositionAddress ? 'open' : 'open_pending'
        : record.lifecycleState;

  const preserveReconciliationEvidence = record.lifecycleState === 'reconcile_required'
    && !input.liveOrderSubmitted
    && input.action === 'hold';
  const lastReason = preserveReconciliationEvidence
    ? record.lastReason ?? input.reason
    : fullExit && isConfirmed && input.exitTriggerReason
      ? input.exitTriggerReason
      : input.reason;

  const isExitAttempt = input.action === 'withdraw-lp'
    || spotExit
    || input.action === 'claim-fee'
    || input.action === 'rebalance-lp';
  records[index] = {
    ...record,
    positionKey: target.chainPositionAddress
      ? positionLedgerKey({
          chainPositionAddress: target.chainPositionAddress,
          positionId: target.positionId,
          poolAddress: target.poolAddress ?? record.activePoolAddress,
          mint: target.tokenMint ?? record.activeMint
        })
      : record.positionKey,
    openIntentId: target.openIntentId ?? record.openIntentId,
    idempotencyKey: target.idempotencyKey ?? record.idempotencyKey,
    positionId: target.chainPositionAddress
      ? createPositionId({ chainPositionAddress: target.chainPositionAddress })
      : record.chainPositionAddress
        ? record.positionId
        : target.positionId ?? record.positionId,
    chainPositionAddress: target.chainPositionAddress ?? record.chainPositionAddress,
    activeMint: target.tokenMint ?? record.activeMint,
    activePoolAddress: target.poolAddress ?? record.activePoolAddress,
    lifecycleState,
    importStatus: (input.action === 'deploy' || input.action === 'add-lp')
      && isConfirmed && input.confirmedFill?.fillAmountSource === 'wallet-delta'
      ? 'imported'
      : record.importStatus,
    ownedTokenAmountRaw: lifecycleState === 'closed'
      ? undefined
      : input.action === 'deploy' && isConfirmed
        ? input.confirmedFill?.acquiredTokenAmountRaw ?? record.ownedTokenAmountRaw
        : record.ownedTokenAmountRaw,
    entrySol: (input.action === 'add-lp' || input.action === 'deploy') && isConfirmed
      ? input.confirmedFill?.actualFilledSol ?? input.confirmedFill?.filledSol ?? record.entrySol
      : record.entrySol,
    entrySolSource: (input.action === 'add-lp' || input.action === 'deploy')
      && isConfirmed && input.confirmedFill?.fillAmountSource === 'wallet-delta'
      ? 'actual_fill'
      : record.entrySolSource,
    entryFillSubmissionId: (input.action === 'add-lp' || input.action === 'deploy') && isConfirmed
      ? input.confirmedFill?.submissionId ?? record.entryFillSubmissionId
      : record.entryFillSubmissionId,
    openedAt: (input.action === 'add-lp' || input.action === 'deploy') && isConfirmed
      ? input.confirmedFill?.recordedAt ?? record.openedAt ?? input.now
      : record.openedAt,
    lastAction: preserveReconciliationEvidence ? record.lastAction : input.action,
    lastReason,
    lastOrderIdempotencyKey: target.idempotencyKey ?? record.lastOrderIdempotencyKey,
    lastExitAttemptAt: isExitAttempt ? input.now : record.lastExitAttemptAt,
    exitAttemptCount: isExitAttempt ? (record.exitAttemptCount ?? 0) + 1 : record.exitAttemptCount,
    pendingSubmissionId: hasPending ? input.persistedPendingSubmission?.submissionId : undefined,
    pendingOrderAction: hasPending ? input.persistedPendingSubmission?.orderAction : undefined,
    pendingConfirmationStatus: hasPending ? input.persistedPendingSubmission?.confirmationStatus : undefined,
    pendingFinality: hasPending ? input.persistedPendingSubmission?.finality : undefined,
    residualCleanupStatus: input.residualCleanupStatus ?? record.residualCleanupStatus,
    residualCleanupValueSol: input.residualCleanupValueSol ?? record.residualCleanupValueSol,
    residualCleanupAmountRaw: input.residualCleanupAmountRaw ?? record.residualCleanupAmountRaw,
    missingOnChainSince: stillOnChain ? undefined : record.missingOnChainSince,
    lastClosedAt: lifecycleState === 'closed' ? input.now : record.lastClosedAt,
    updatedAt: input.now
  };

  if (lifecycleState === 'closed' && records[index].chainPositionAddress) {
    const closedRecord = records[index];
    const poolMintFallbackCanSupersede = (candidate: PositionLedgerRecord) => {
      if (
        !candidate.missingOnChainSince ||
        !closedRecord.lastClosedAt ||
        !candidate.activePoolAddress ||
        !candidate.activeMint ||
        candidate.activePoolAddress !== closedRecord.activePoolAddress ||
        candidate.activeMint !== closedRecord.activeMint
      ) {
        return false;
      }

      const candidateOpenedAtMs = candidate.openedAt ? Date.parse(candidate.openedAt) : Number.NaN;
      const closedAtMs = Date.parse(closedRecord.lastClosedAt);
      return Number.isFinite(candidateOpenedAtMs) && Number.isFinite(closedAtMs)
        ? candidateOpenedAtMs <= closedAtMs
        : false;
    };

    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const candidate = records[recordIndex];
      if (
        recordIndex === index ||
        candidate.chainPositionAddress ||
        candidate.lifecycleState === 'closed'
      ) {
        continue;
      }

      const identityMatches = Boolean(
        (closedRecord.openIntentId && candidate.openIntentId === closedRecord.openIntentId)
        || (closedRecord.idempotencyKey && candidate.idempotencyKey === closedRecord.idempotencyKey)
        || (closedRecord.entryFillSubmissionId && candidate.entryFillSubmissionId === closedRecord.entryFillSubmissionId)
        || poolMintFallbackCanSupersede(candidate)
      );

      if (!identityMatches) {
        continue;
      }

      records[recordIndex] = {
        ...candidate,
        lifecycleState: 'closed',
        importStatus: 'superseded_closed',
        supersededByPositionKey: closedRecord.positionKey,
        lastAction: 'withdraw-lp',
        lastReason: 'superseded-by-chain-closed-position',
        missingOnChainSince: candidate.missingOnChainSince ?? input.now,
        lastClosedAt: input.now,
        updatedAt: input.now
      };
    }
  }

  return {
    version: 1,
    records: normalizeLedgerLifecycleRecords(records, input.now, input.persistedPendingSubmission ?? input.pendingSubmissionBeforeCycle),
    updatedAt: input.now
  };
}

export function isPositionLedgerRecordBusinessActive(record: PositionLedgerRecord) {
  return isPositionRecordBusinessActive(record);
}

export function summarizePositionLedger(ledger?: PositionLedgerSnapshot | null) {
  const projection = buildLifecycleProjection({
    ledger,
    blockNewOpensOnReconcileRequired: false
  });
  const activeRecords = projection.businessActiveRecords;
  return {
    activeLpCount: projection.activeLpCount,
    chainActiveLpCount: projection.chainActiveLpCount,
    pendingOpenCount: projection.pendingOpenCount,
    reconcileRequiredCount: projection.reconcileRequiredCount,
    residualCleanupRequiredCount: projection.residualCleanupRequiredCount,
    managedLpCount: projection.managedLpCount,
    importFailedLpCount: projection.importFailedLpCount
  };
}

function findCompatibilityPriorIndex(
  records: PositionLedgerRecord[],
  prior?: PositionStateSnapshot | null
) {
  if (!prior) {
    return -1;
  }

  if (prior.chainPositionAddress) {
    return records.findIndex((record) =>
      record.chainPositionAddress === prior.chainPositionAddress
      || record.positionId === prior.chainPositionAddress
      || record.positionKey === `chain-position:${prior.chainPositionAddress}`
    );
  }

  if (prior.positionId) {
    return records.findIndex((record) =>
      record.positionId === prior.positionId
      || record.positionKey === `position:${prior.positionId}`
    );
  }

  if (prior.openIntentId) {
    return records.findIndex((record) =>
      record.openIntentId === prior.openIntentId
      || record.positionKey === `open-intent:${prior.openIntentId}`
    );
  }

  if (!prior.activePoolAddress || !prior.activeMint) {
    return -1;
  }

  const matches = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) =>
      record.activePoolAddress === prior.activePoolAddress
      && record.activeMint === prior.activeMint
    );
  return matches.length === 1 ? matches[0].index : -1;
}

function findCompatibilityPendingRecord(
  records: PositionLedgerRecord[],
  pendingSubmission?: PendingSubmissionSnapshot | null
) {
  if (!pendingSubmission || pendingSubmission.confirmationStatus === 'failed') {
    return undefined;
  }

  if (pendingSubmission.chainPositionAddress) {
    return records.find((record) =>
      record.chainPositionAddress === pendingSubmission.chainPositionAddress
      || record.positionId === pendingSubmission.chainPositionAddress
      || record.positionKey === `chain-position:${pendingSubmission.chainPositionAddress}`
    );
  }

  if (pendingSubmission.positionId) {
    return records.find((record) =>
      record.positionId === pendingSubmission.positionId
      || record.positionKey === `position:${pendingSubmission.positionId}`
    );
  }

  if (pendingSubmission.openIntentId) {
    return records.find((record) =>
      record.openIntentId === pendingSubmission.openIntentId
      || record.positionKey === `open-intent:${pendingSubmission.openIntentId}`
    );
  }

  const idempotencyMatch = records.find((record) =>
    record.idempotencyKey === pendingSubmission.idempotencyKey
    || record.lastOrderIdempotencyKey === pendingSubmission.idempotencyKey
    || record.positionKey === `idempotency:${pendingSubmission.idempotencyKey}`
  );
  if (idempotencyMatch) {
    return idempotencyMatch;
  }

  const submissionMatch = records.find((record) =>
    record.pendingSubmissionId === pendingSubmission.submissionId
  );
  if (submissionMatch) {
    return submissionMatch;
  }

  if (!pendingSubmission.poolAddress || !pendingSubmission.tokenMint) {
    return undefined;
  }
  const poolMintMatches = records.filter((record) =>
    record.activePoolAddress === pendingSubmission.poolAddress
    && record.activeMint === pendingSubmission.tokenMint
  );
  return poolMintMatches.length === 1 ? poolMintMatches[0] : undefined;
}

export function selectCompatibilityPositionState(input: {
  ledger?: PositionLedgerSnapshot | null;
  pendingSubmission?: PendingSubmissionSnapshot | null;
  prior?: PositionStateSnapshot | null;
  advance?: boolean;
  allowNewOpens: boolean;
  flattenOnly: boolean;
  lastAction: string;
  lastReason?: string;
  walletSol?: number;
  now: string;
}): PositionStateSnapshot {
  const activeRecords = [...(input.ledger?.records ?? [])]
    .filter((record) =>
      isPositionRecordBusinessActive(record, input.pendingSubmission, { now: input.now })
      || record.lifecycleState === 'reconcile_required'
    )
    .sort((a, b) =>
      (a.openedAt || a.updatedAt || '').localeCompare(b.openedAt || b.updatedAt || '')
      || a.positionKey.localeCompare(b.positionKey)
    );
  const pendingRecord = findCompatibilityPendingRecord(activeRecords, input.pendingSubmission);
  const criticalExitRecords = activeRecords
    .filter((record) =>
      record.lifecycleState === 'lp_exit_pending'
      || record.lifecycleState === 'inventory_exit_pending'
      || record.lifecycleState === 'inventory_exit_ready'
      || record.lastRiskSentinel?.riskIntent === 'range-exit'
      || record.lastRiskSentinel?.riskIntent === 'liquidity-exit'
      || record.lastRiskSentinel?.riskIntent === 'volatility-exit'
    )
    .sort((a, b) =>
      (b.lastRiskSentinel?.outOfRangeBins ?? 0) - (a.lastRiskSentinel?.outOfRangeBins ?? 0)
      || (b.lastRiskSentinel?.solDepletedRatio ?? 0) - (a.lastRiskSentinel?.solDepletedRatio ?? 0)
      || (a.openedAt || a.updatedAt || '').localeCompare(b.openedAt || b.updatedAt || '')
      || a.positionKey.localeCompare(b.positionKey)
    );
  const priorIndex = findCompatibilityPriorIndex(activeRecords, input.prior);
  const priorRecord = priorIndex >= 0 ? activeRecords[priorIndex] : undefined;
  const priorCriticalIndex = priorRecord
    ? criticalExitRecords.findIndex((record) => record.positionKey === priorRecord.positionKey)
    : -1;
  const criticalExitRecord = criticalExitRecords.length === 0
    ? undefined
    : input.advance && priorCriticalIndex >= 0
      ? criticalExitRecords[(priorCriticalIndex + 1) % criticalExitRecords.length]
      : criticalExitRecords[0];
  const normalRecord = priorIndex < 0
    ? activeRecords[0]
    : input.advance
      ? activeRecords[(priorIndex + 1) % activeRecords.length]
      : activeRecords[priorIndex];
  const activeRecord = pendingRecord ?? criticalExitRecord ?? normalRecord;

  if (!activeRecord) {
    return {
      ...(input.prior ?? {
        lastClosedMint: '',
        lastClosedAt: ''
      }),
      allowNewOpens: input.allowNewOpens,
      flattenOnly: input.flattenOnly,
      lastAction: input.lastAction,
      lastReason: input.lastReason,
      openIntentId: undefined,
      positionId: undefined,
      chainPositionAddress: undefined,
      activeMint: undefined,
      activePoolAddress: undefined,
      lifecycleState: 'closed',
      ownedTokenAmountRaw: undefined,
      entrySol: undefined,
      entrySolSource: undefined,
      entryFillSubmissionId: undefined,
      openedAt: undefined,
      walletSol: input.walletSol,
      updatedAt: input.now
    };
  }

  return {
    allowNewOpens: input.allowNewOpens,
    flattenOnly: input.flattenOnly,
    lastAction: input.lastAction,
    lastReason: activeRecord.lifecycleState === 'reconcile_required'
      ? activeRecord.lastReason ?? input.lastReason
      : input.lastReason,
    openIntentId: activeRecord.openIntentId,
    positionId: activeRecord.positionId,
    chainPositionAddress: activeRecord.chainPositionAddress,
    activeMint: activeRecord.activeMint,
    activePoolAddress: activeRecord.activePoolAddress,
    lifecycleState: activeRecord.lifecycleState,
    ownedTokenAmountRaw: activeRecord.ownedTokenAmountRaw,
    entrySol: activeRecord.entrySol,
    entrySolSource: activeRecord.entrySolSource,
    entryFillSubmissionId: activeRecord.entryFillSubmissionId,
    openedAt: activeRecord.openedAt,
    valuationStatus: activeRecord.valuationStatus,
    valuationReason: activeRecord.valuationReason,
    valuationTrust: activeRecord.valuationTrust,
    valuationSource: activeRecord.valuationSource,
    valuationCompleteness: activeRecord.valuationCompleteness,
    exitQuoteValueSol: activeRecord.exitQuoteValueSol,
    marketValueSol: activeRecord.marketValueSol,
    displayValueSol: activeRecord.displayValueSol,
    lpTotalValueSol: activeRecord.lpTotalValueSol,
    lastValuationAt: activeRecord.lastValuationAt,
    lastRiskSentinel: activeRecord.lastRiskSentinel,
    lastClosedMint: input.prior?.lastClosedMint ?? '',
    lastClosedAt: input.prior?.lastClosedAt ?? activeRecord.lastClosedAt,
    walletSol: input.walletSol,
    updatedAt: input.now
  };
}
