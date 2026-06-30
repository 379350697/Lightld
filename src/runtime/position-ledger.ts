import type { LiveAccountState } from './live-account-provider.ts';
import { createPositionId } from './lp-position-record.ts';
import type {
  PendingSubmissionSnapshot,
  PositionLedgerRecord,
  PositionLedgerSnapshot,
  PositionStateSnapshot
} from './state-types.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);

type AccountLpPosition = NonNullable<LiveAccountState['walletLpPositions']>[number];

function isNonStableMint(mint?: string) {
  return typeof mint === 'string' && mint.length > 0 && mint !== SOL_MINT && !STABLE_MINTS.has(mint);
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

function findMatchingRecord(records: PositionLedgerRecord[], position: AccountLpPosition) {
  const chainPositionAddress = position.chainPositionAddress || position.positionAddress;
  if (chainPositionAddress) {
    const byChain = records.find((record) =>
      record.chainPositionAddress === chainPositionAddress ||
      record.positionId === chainPositionAddress ||
      record.positionKey === `chain-position:${chainPositionAddress}`
    );
    if (byChain) {
      return byChain;
    }

    const pendingOpenMatches = records.filter((record) =>
      record.lifecycleState === 'open_pending' &&
      !record.chainPositionAddress &&
      record.activeMint === position.mint &&
      record.activePoolAddress === position.poolAddress
    );
    if (pendingOpenMatches.length === 1) {
      return pendingOpenMatches[0];
    }
  }

  if (position.positionId) {
    return records.find((record) =>
      record.lifecycleState !== 'closed' &&
      (record.positionId === position.positionId || record.positionKey === `position:${position.positionId}`)
    );
  }

  return undefined;
}

function resolveEntryFromFills(input: {
  position: AccountLpPosition;
  accountState?: LiveAccountState;
  activePositions: AccountLpPosition[];
}) {
  const chainPositionAddress = input.position.chainPositionAddress || input.position.positionAddress;
  const samePoolMintActiveCount = input.activePositions.filter((position) =>
    position.poolAddress === input.position.poolAddress && position.mint === input.position.mint
  ).length;
  const fills = [...(input.accountState?.fills ?? [])].reverse();
  const fill = fills.find((entry) =>
    entry.side === 'add-lp' &&
    entry.mint === input.position.mint &&
    (
      (chainPositionAddress && (
        entry.chainPositionAddress === chainPositionAddress ||
        entry.positionId === chainPositionAddress
      )) ||
      (samePoolMintActiveCount <= 1 && (
        entry.positionId === `${input.position.poolAddress}:${input.position.mint}` ||
        (entry as any).poolAddress === input.position.poolAddress
      ))
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

    const existing = findMatchingRecord(records, position);
    const entry = existing?.entrySol
      ? {
          entrySol: existing.entrySol,
          entrySolSource: existing.entrySolSource,
          entryFillSubmissionId: existing.entryFillSubmissionId,
          openedAt: existing.openedAt
        }
      : resolveEntryFromFills({
          position,
          accountState: input.accountState,
          activePositions
        });
    const nextRecord: PositionLedgerRecord = {
      ...(existing ?? {
        lastAction: 'hold'
      }),
      positionKey: key,
      positionId: chainPositionAddress
        ? createPositionId({ chainPositionAddress })
        : position.positionId ?? existing?.positionId,
      chainPositionAddress,
      activeMint: position.mint,
      activePoolAddress: position.poolAddress,
      lifecycleState: 'open',
      entrySol: entry?.entrySol,
      entrySolSource: entry?.entrySolSource,
      entryFillSubmissionId: entry?.entryFillSubmissionId,
      openedAt: entry?.openedAt ?? existing?.openedAt,
      importStatus: entry?.entrySol ? 'imported' : 'entry_unknown',
      valuationStatus: position.valuationStatus as PositionLedgerRecord['valuationStatus'],
      valuationReason: position.valuationReason,
      exitQuoteValueSol: position.currentValueSol,
      displayValueSol: position.currentValueSol,
      lpTotalValueSol: position.currentValueSol,
      lastValuationAt: position.lastValuationAt,
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
  }

  const shouldCloseMissing = input.closeMissingActive === true && !input.pendingSubmission;
  const nextRecords = records.map((record) => {
    if (record.lifecycleState === 'closed' || !record.chainPositionAddress) {
      return record;
    }

    const recordKey = positionLedgerKey({
      chainPositionAddress: record.chainPositionAddress,
      positionId: record.positionId,
      poolAddress: record.activePoolAddress,
      mint: record.activeMint
    });

    if (activeKeys.has(recordKey)) {
      return record;
    }

    if (!shouldCloseMissing) {
      return {
        ...record,
        missingOnChainSince: record.missingOnChainSince ?? input.now,
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
    records: nextRecords,
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

  if (input.positionId) {
    return input.record.positionId === input.positionId || input.record.positionKey === `position:${input.positionId}`;
  }

  if (input.openIntentId) {
    return input.record.openIntentId === input.openIntentId || input.record.positionKey === `open-intent:${input.openIntentId}`;
  }

  if (input.idempotencyKey) {
    return input.record.idempotencyKey === input.idempotencyKey || input.record.positionKey === `idempotency:${input.idempotencyKey}`;
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
  };
  action: string;
  reason: string;
  liveOrderSubmitted: boolean;
  confirmationStatus?: string;
  finality?: string;
  confirmedFill?: {
    submissionId: string;
    actualFilledSol?: number;
    filledSol: number;
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
    now: input.now
  });

  if (input.action === 'dca-out') {
    return imported;
  }

  const target = {
    chainPositionAddress: input.actionIdentity?.chainPositionAddress
      ?? input.persistedPendingSubmission?.chainPositionAddress
      ?? input.pendingSubmissionBeforeCycle?.chainPositionAddress
      ?? input.positionState?.chainPositionAddress,
    positionId: input.actionIdentity?.positionId
      ?? input.persistedPendingSubmission?.positionId
      ?? input.pendingSubmissionBeforeCycle?.positionId
      ?? input.positionState?.positionId,
    openIntentId: input.actionIdentity?.openIntentId
      ?? input.persistedPendingSubmission?.openIntentId
      ?? input.pendingSubmissionBeforeCycle?.openIntentId
      ?? input.positionState?.openIntentId,
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
    !input.actionIdentity &&
    !input.orderIntent
  ) {
    return imported;
  }

  const records = [...imported.records];
  let index = records.findIndex((record) => recordMatchesTarget({ record, ...target }));
  if (index < 0 && (input.action === 'add-lp' || target.poolAddress || target.tokenMint || target.openIntentId || target.idempotencyKey)) {
    records.push({
      positionKey: positionLedgerKey({
        chainPositionAddress: target.chainPositionAddress,
        positionId: target.positionId,
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
      lifecycleState: input.action === 'add-lp' ? 'open_pending' : 'lp_exit_pending',
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
  const hasPending = Boolean(input.persistedPendingSubmission);
  const isConfirmed = input.confirmationStatus === 'confirmed';
  const fullExit = input.action === 'withdraw-lp';
  const stillOnChain = hasActivePositionForRecord({
    record,
    accountState: input.accountState
  });
  const terminalAlreadyClosed = fullExit
    && (input.reason.includes('position-already-closed') || /position not found for pool/i.test(input.reason))
    && !stillOnChain;
  const lifecycleState = fullExit && (isConfirmed || terminalAlreadyClosed) && !stillOnChain
    ? 'closed'
    : hasPending && fullExit
      ? 'lp_exit_pending'
      : hasPending && input.action === 'add-lp'
        ? 'open_pending'
        : isConfirmed && input.action === 'add-lp'
          ? 'open'
          : record.lifecycleState;

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
      : target.positionId ?? record.positionId,
    chainPositionAddress: target.chainPositionAddress ?? record.chainPositionAddress,
    activeMint: target.tokenMint ?? record.activeMint,
    activePoolAddress: target.poolAddress ?? record.activePoolAddress,
    lifecycleState,
    entrySol: input.action === 'add-lp' && isConfirmed
      ? input.confirmedFill?.actualFilledSol ?? input.confirmedFill?.filledSol ?? record.entrySol
      : record.entrySol,
    entrySolSource: input.action === 'add-lp' && isConfirmed && input.confirmedFill?.fillAmountSource === 'wallet-delta'
      ? 'actual_fill'
      : record.entrySolSource,
    entryFillSubmissionId: input.action === 'add-lp' && isConfirmed
      ? input.confirmedFill?.submissionId ?? record.entryFillSubmissionId
      : record.entryFillSubmissionId,
    openedAt: input.action === 'add-lp' && isConfirmed
      ? input.confirmedFill?.recordedAt ?? record.openedAt ?? input.now
      : record.openedAt,
    lastAction: input.action,
    lastReason: input.reason,
    lastOrderIdempotencyKey: target.idempotencyKey ?? record.lastOrderIdempotencyKey,
    pendingSubmissionId: hasPending ? input.persistedPendingSubmission?.submissionId : undefined,
    pendingOrderAction: hasPending ? input.persistedPendingSubmission?.orderAction : undefined,
    pendingConfirmationStatus: hasPending ? input.persistedPendingSubmission?.confirmationStatus : undefined,
    pendingFinality: hasPending ? input.persistedPendingSubmission?.finality : undefined,
    missingOnChainSince: stillOnChain ? undefined : record.missingOnChainSince,
    lastClosedAt: lifecycleState === 'closed' ? input.now : record.lastClosedAt,
    updatedAt: input.now
  };

  return {
    version: 1,
    records,
    updatedAt: input.now
  };
}

export function isPositionLedgerRecordBusinessActive(record: PositionLedgerRecord) {
  return record.lifecycleState !== 'closed' && !record.missingOnChainSince;
}

export function summarizePositionLedger(ledger?: PositionLedgerSnapshot | null) {
  const records = ledger?.records ?? [];
  const activeRecords = records.filter((record) => isPositionLedgerRecordBusinessActive(record));
  return {
    activeLpCount: activeRecords.length,
    managedLpCount: activeRecords.filter((record) => record.importStatus !== 'import_failed').length,
    importFailedLpCount: activeRecords.filter((record) => record.importStatus === 'import_failed').length
  };
}

export function selectCompatibilityPositionState(input: {
  ledger?: PositionLedgerSnapshot | null;
  prior?: PositionStateSnapshot | null;
  allowNewOpens: boolean;
  flattenOnly: boolean;
  lastAction: string;
  lastReason?: string;
  walletSol?: number;
  now: string;
}): PositionStateSnapshot {
  const activeRecord = [...(input.ledger?.records ?? [])]
    .filter((record) => isPositionLedgerRecordBusinessActive(record))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];

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
    lastReason: input.lastReason,
    openIntentId: activeRecord.openIntentId,
    positionId: activeRecord.positionId,
    chainPositionAddress: activeRecord.chainPositionAddress,
    activeMint: activeRecord.activeMint,
    activePoolAddress: activeRecord.activePoolAddress,
    lifecycleState: activeRecord.lifecycleState,
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
    lastClosedMint: input.prior?.lastClosedMint ?? '',
    lastClosedAt: input.prior?.lastClosedAt ?? activeRecord.lastClosedAt,
    walletSol: input.walletSol,
    updatedAt: input.now
  };
}
