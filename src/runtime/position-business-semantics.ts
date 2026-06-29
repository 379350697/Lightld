import type { LiveAccountState } from './live-account-provider.ts';
import type { PendingSubmissionSnapshot, PositionLedgerSnapshot, PositionStateSnapshot } from './state-types.ts';
import type { LiveAction } from './action-semantics.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);

export type BusinessLpPosition = NonNullable<LiveAccountState['walletLpPositions']>[number];

export type PositionBusinessAction = 'maintain' | 'exit' | 'cleanup-dust' | 'hold' | 'open';
export type ResidualDustState = 'none' | 'dust_ignored' | 'dust_cleanup_pending';
export type PositionPendingState = 'none' | 'open' | 'exit' | 'maintenance';
export type BusinessActionIntent = 'lp-maintenance' | 'lp-exit' | 'residual-cleanup' | 'new-open' | 'hold';

export type MaintenanceOutcome = {
  action?: string;
  reason?: string;
  liveOrderSubmitted?: boolean;
  failureKind?: string;
};

export type PositionBusinessSemantics = {
  activeLpPositions: BusinessLpPosition[];
  managedActiveLp?: BusinessLpPosition;
  untrackedActiveLpPositions: BusinessLpPosition[];
  activeLpCount: number;
  managedLpCount: number;
  importFailedLpCount: number;
  hasActiveLp: boolean;
  hasPendingOpen: boolean;
  hasPendingExit: boolean;
  hasPendingMaintenance: boolean;
  pendingState: PositionPendingState;
  residualDustState: ResidualDustState;
  residualState: {
    status: ResidualDustState;
    cleanupMints: string[];
    ignoredMints: string[];
  };
  dustTokenMints: string[];
  maintenanceIntent: BusinessActionIntent;
  canOpenNewPosition: {
    allowed: boolean;
    reason: string;
  };
  canRunNewOpenAfterMaintenance: {
    allowed: boolean;
    reason: string;
  };
  nextAction: PositionBusinessAction;
};

function isNonStableMint(mint: string) {
  return mint.length > 0 && mint !== SOL_MINT && !STABLE_MINTS.has(mint);
}

function activeLpKey(position: BusinessLpPosition) {
  return position.chainPositionAddress
    || position.positionAddress
    || position.positionId
    || `${position.poolAddress}:${position.mint}`;
}

function ledgerRecordMatchesPosition(input: {
  ledger?: PositionLedgerSnapshot | null;
  position: BusinessLpPosition;
}) {
  const records = input.ledger?.records ?? [];
  const chainPositionAddress = input.position.chainPositionAddress || input.position.positionAddress;
  return records.some((record) => {
    if (record.lifecycleState === 'closed') {
      return false;
    }
    if (chainPositionAddress) {
      return record.chainPositionAddress === chainPositionAddress
        || record.positionId === chainPositionAddress
        || record.positionKey === `chain-position:${chainPositionAddress}`;
    }
    return record.activeMint === input.position.mint && record.activePoolAddress === input.position.poolAddress;
  });
}

function collectActiveLpPositions(accountState?: LiveAccountState): BusinessLpPosition[] {
  const positions: BusinessLpPosition[] = [];
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

export function matchesBusinessLpTarget(input: {
  position: BusinessLpPosition;
  positionState?: PositionStateSnapshot | null;
  chainPositionAddress?: string;
  activeMint?: string;
  activePoolAddress?: string;
}) {
  const chainPositionAddress = input.chainPositionAddress ?? input.positionState?.chainPositionAddress;
  const activePoolAddress = input.activePoolAddress ?? input.positionState?.activePoolAddress;
  const activeMint = input.activeMint ?? input.positionState?.activeMint;

  if (chainPositionAddress) {
    return input.position.positionAddress === chainPositionAddress
      || input.position.chainPositionAddress === chainPositionAddress
      || input.position.positionId === chainPositionAddress;
  }

  if (activePoolAddress) {
    return input.position.poolAddress === activePoolAddress;
  }

  if (activeMint) {
    return input.position.mint === activeMint;
  }

  return false;
}

function isPendingOpen(pendingSubmission?: PendingSubmissionSnapshot | null) {
  if (!pendingSubmission || pendingSubmission.confirmationStatus === 'failed') {
    return false;
  }

  return pendingSubmission.orderAction === 'add-lp'
    || pendingSubmission.orderAction === 'deploy';
}

function isPendingExit(pendingSubmission?: PendingSubmissionSnapshot | null) {
  if (!pendingSubmission || pendingSubmission.confirmationStatus === 'failed') {
    return false;
  }

  return pendingSubmission.orderAction === 'withdraw-lp'
    || pendingSubmission.orderAction === 'dca-out';
}

function isPendingMaintenance(pendingSubmission?: PendingSubmissionSnapshot | null) {
  if (!pendingSubmission || pendingSubmission.confirmationStatus === 'failed') {
    return false;
  }

  return pendingSubmission.orderAction === 'claim-fee'
    || pendingSubmission.orderAction === 'rebalance-lp';
}

function collectDustTokens(input: {
  accountState?: LiveAccountState;
  residualTokenSweepMinValueSol: number;
}) {
  const cleanupMints: string[] = [];
  const ignoredMints: string[] = [];

  for (const token of [
    ...(input.accountState?.walletTokens ?? []),
    ...(input.accountState?.journalTokens ?? [])
  ]) {
    if (!isNonStableMint(token.mint) || token.amount <= 0) {
      continue;
    }

    if (typeof token.currentValueSol !== 'number' || !Number.isFinite(token.currentValueSol)) {
      ignoredMints.push(token.mint);
      continue;
    }

    if (token.currentValueSol < input.residualTokenSweepMinValueSol) {
      ignoredMints.push(token.mint);
      continue;
    }

    cleanupMints.push(token.mint);
  }

  return { cleanupMints, ignoredMints };
}

function classifyActionIntent(action?: string): BusinessActionIntent | undefined {
  if (!action || action === 'hold') {
    return action === 'hold' ? 'hold' : undefined;
  }

  if (action === 'withdraw-lp') {
    return 'lp-exit';
  }

  if (action === 'claim-fee' || action === 'rebalance-lp') {
    return 'lp-maintenance';
  }

  if (action === 'dca-out') {
    return 'residual-cleanup';
  }

  if (action === 'deploy' || action === 'add-lp') {
    return 'new-open';
  }

  return 'hold';
}

function resolveDefaultMaintenanceIntent(input: {
  maintenanceOutcome?: MaintenanceOutcome;
  activeLpCount: number;
  residualDustState: ResidualDustState;
}): BusinessActionIntent {
  const outcomeIntent = classifyActionIntent(input.maintenanceOutcome?.action);
  if (outcomeIntent) {
    return outcomeIntent;
  }

  if (input.activeLpCount > 0) {
    return 'lp-maintenance';
  }

  if (input.residualDustState === 'dust_cleanup_pending') {
    return 'residual-cleanup';
  }

  return 'hold';
}

function resolveCanRunNewOpenAfterMaintenance(input: {
  canOpenNewPosition: PositionBusinessSemantics['canOpenNewPosition'];
  maintenanceOutcome?: MaintenanceOutcome;
}) {
  if (input.maintenanceOutcome?.liveOrderSubmitted) {
    return { allowed: false, reason: 'maintenance-order-submitted' };
  }

  const maintenanceIntent = classifyActionIntent(input.maintenanceOutcome?.action);
  if (maintenanceIntent === 'lp-exit') {
    const reason = input.maintenanceOutcome?.reason
      || input.maintenanceOutcome?.failureKind
      || 'not-submitted';
    return { allowed: false, reason: `maintenance-lp-exit-not-submitted:${reason}` };
  }

  return input.canOpenNewPosition;
}

export function resolvePositionBusinessSemantics(input: {
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot | null;
  positionLedger?: PositionLedgerSnapshot | null;
  pendingSubmission?: PendingSubmissionSnapshot | null;
  maintenanceOutcome?: MaintenanceOutcome;
  residualTokenSweepMinValueSol?: number;
  maxActivePositions?: number;
}): PositionBusinessSemantics {
  const residualTokenSweepMinValueSol = input.residualTokenSweepMinValueSol ?? 0.1;
  const maxActivePositions = input.maxActivePositions ?? 5;
  const activeLpPositions = collectActiveLpPositions(input.accountState);
  const managedActiveLp = activeLpPositions.find((position) =>
    ledgerRecordMatchesPosition({
      ledger: input.positionLedger,
      position
    }) || matchesBusinessLpTarget({
      position,
      positionState: input.positionState
    })
  );
  const untrackedActiveLpPositions = activeLpPositions.filter((position) =>
    !ledgerRecordMatchesPosition({
      ledger: input.positionLedger,
      position
    }) && !matchesBusinessLpTarget({
      position,
      positionState: input.positionState
    })
  );
  const activeLedgerRecords = (input.positionLedger?.records ?? []).filter((record) => record.lifecycleState !== 'closed');
  const activeLpCount = Math.max(activeLpPositions.length, activeLedgerRecords.length);
  const managedLpCount = activeLedgerRecords.filter((record) => record.importStatus !== 'import_failed').length;
  const importFailedLpCount = activeLedgerRecords.filter((record) => record.importStatus === 'import_failed').length;
  const hasPendingOpen = isPendingOpen(input.pendingSubmission);
  const hasPendingExit = isPendingExit(input.pendingSubmission);
  const hasPendingMaintenance = isPendingMaintenance(input.pendingSubmission);
  const dustTokens = collectDustTokens({
    accountState: input.accountState,
    residualTokenSweepMinValueSol
  });
  const residualDustState: ResidualDustState = dustTokens.cleanupMints.length > 0
    ? 'dust_cleanup_pending'
    : dustTokens.ignoredMints.length > 0
      ? 'dust_ignored'
      : 'none';
  const dustTokenMints = [...dustTokens.cleanupMints, ...dustTokens.ignoredMints];
  const pendingState: PositionPendingState = hasPendingExit
    ? 'exit'
    : hasPendingOpen
      ? 'open'
      : hasPendingMaintenance
        ? 'maintenance'
        : 'none';
  const residualState = {
    status: residualDustState,
    cleanupMints: dustTokens.cleanupMints,
    ignoredMints: dustTokens.ignoredMints
  };
  const maintenanceIntent = resolveDefaultMaintenanceIntent({
    maintenanceOutcome: input.maintenanceOutcome,
    activeLpCount,
    residualDustState
  });
  const buildResult = (overrides: {
    hasActiveLp: boolean;
    canOpenNewPosition: PositionBusinessSemantics['canOpenNewPosition'];
    nextAction: PositionBusinessAction;
  }): PositionBusinessSemantics => ({
    activeLpPositions,
    managedActiveLp,
    untrackedActiveLpPositions,
    activeLpCount,
    managedLpCount,
    importFailedLpCount,
    hasActiveLp: overrides.hasActiveLp,
    hasPendingOpen,
    hasPendingExit,
    hasPendingMaintenance,
    pendingState,
    residualDustState,
    residualState,
    dustTokenMints,
    maintenanceIntent,
    canOpenNewPosition: overrides.canOpenNewPosition,
    canRunNewOpenAfterMaintenance: resolveCanRunNewOpenAfterMaintenance({
      canOpenNewPosition: overrides.canOpenNewPosition,
      maintenanceOutcome: input.maintenanceOutcome
    }),
    nextAction: overrides.nextAction
  });

  if (hasPendingExit) {
    return buildResult({
      hasActiveLp: activeLpCount > 0,
      canOpenNewPosition: { allowed: false, reason: 'pending-exit' },
      nextAction: 'hold'
    });
  }

  if (hasPendingOpen) {
    return buildResult({
      hasActiveLp: activeLpCount > 0,
      canOpenNewPosition: { allowed: false, reason: 'pending-open' },
      nextAction: 'hold'
    });
  }

  if (hasPendingMaintenance) {
    return buildResult({
      hasActiveLp: activeLpCount > 0,
      canOpenNewPosition: { allowed: false, reason: 'pending-maintenance' },
      nextAction: 'hold'
    });
  }

  if (importFailedLpCount > 0) {
    return buildResult({
      hasActiveLp: true,
      canOpenNewPosition: { allowed: false, reason: 'position-ledger-import-failed' },
      nextAction: 'hold'
    });
  }

  if (residualDustState === 'dust_cleanup_pending') {
    return buildResult({
      hasActiveLp: activeLpCount > 0,
      canOpenNewPosition: { allowed: false, reason: 'residual-dust-cleanup-pending' },
      nextAction: 'cleanup-dust'
    });
  }

  if (activeLpCount >= maxActivePositions) {
    return buildResult({
      hasActiveLp: activeLpCount > 0,
      canOpenNewPosition: { allowed: false, reason: 'position-capacity-full' },
      nextAction: activeLpCount > 0 ? 'maintain' : 'hold'
    });
  }

  return buildResult({
    hasActiveLp: activeLpCount > 0,
    canOpenNewPosition: {
      allowed: true,
      reason: activeLpCount > 0
        ? 'capacity-available'
        : residualDustState === 'dust_ignored' ? 'flat-dust-ignored' : 'flat'
    },
    nextAction: activeLpCount > 0 ? 'maintain' : 'open'
  });
}

export function isPositionAlreadyClosedTerminal(input: {
  action?: string;
  reason?: string;
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot | null;
  chainPositionAddress?: string;
  activeMint?: string;
  activePoolAddress?: string;
}) {
  const action = input.action as LiveAction | undefined;
  if (action !== 'withdraw-lp') {
    return false;
  }

  if (!input.reason?.includes('position-already-closed')) {
    return false;
  }

  return !collectActiveLpPositions(input.accountState).some((position) =>
    matchesBusinessLpTarget({
      position,
      positionState: input.positionState,
      chainPositionAddress: input.chainPositionAddress,
      activeMint: input.activeMint,
      activePoolAddress: input.activePoolAddress
    })
  );
}
