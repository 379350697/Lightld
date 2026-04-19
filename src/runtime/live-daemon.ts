import { join } from 'node:path';

import { createDependencyHealthSnapshot, markDependencyFailure, markDependencySuccess } from './dependency-health.ts';
import { buildHealthReport } from './health-report.ts';
import { enqueueMirrorCatchupFromJournals } from '../observability/mirror-catchup.ts';
import { toRuntimeSnapshotEvent } from '../observability/mirror-adapters.ts';
import type { MirrorRuntime } from '../observability/mirror-runtime.ts';
import {
  LiveCycleOutcomeStore,
  WatchlistStore,
  resolveEvolutionPaths,
  type EvolutionWatchlistCandidate,
  type TrackedWatchTokenRecord,
  type WatchlistSnapshotRecord
} from '../evolution/index.ts';
import { PendingSubmissionStore } from './pending-submission-store.ts';
import { RuntimeStateStore } from './runtime-state-store.ts';
import { deriveRuntimeMode } from './runtime-mode-policy.ts';
import { runLiveCycle, type LiveCycleInput, type StrategyId } from './live-cycle.ts';
import { recoverPendingSubmission } from './pending-submission-recovery.ts';
import type { PositionLifecycleState, RuntimeMode } from './state-types.ts';
import { isExposureReducingAction } from './action-semantics.ts';
import type { LiveAccountState, LiveAccountStateProvider } from './live-account-provider.ts';
import type { HousekeepingRunner } from './housekeeping.ts';
import type { AlertSink } from './alert-sink.ts';
import { NoopAlertSink, shouldSendAlert } from './alert-sink.ts';
import { ExecutionRequestError } from '../execution/error-classification.ts';
import type { LiveConfirmationProvider } from '../execution/live-confirmation-provider.ts';
import { isManageableLpPosition } from './lp-position-visibility.ts';
import { createPositionId, markOrphanedLpPosition } from './lp-position-record.ts';

type LiveDaemonOptions = {
  strategy: StrategyId;
  stateRootDir?: string;
  journalRootDir?: string;
  tickIntervalMs?: number;
  hotTickIntervalMs?: number;
  rateLimitBackoffIntervalMs?: number;
  maxTicks?: number;
  buildCycleInput?: (tickCount: number) => Promise<Omit<LiveCycleInput, 'strategy'>> | Omit<LiveCycleInput, 'strategy'>;
  alertSink?: AlertSink;
  mirrorRuntime?: MirrorRuntime;
  housekeepingRunner?: HousekeepingRunner;
  accountProvider?: LiveAccountStateProvider;
  confirmationProvider?: LiveConfirmationProvider;
  evolutionWatchlistStore?: Pick<WatchlistStore, 'readTrackedTokens' | 'writeTrackedTokens' | 'readSnapshots' | 'appendSnapshot'>;
  evolutionOutcomeStore?: Pick<LiveCycleOutcomeStore, 'appendOutcome'>;
  sleep?: (delayMs: number) => Promise<void>;
};

const TRANSIENT_CIRCUIT_RECOVERY_SUCCESS_TICKS = 2;
const WATCHLIST_WINDOWS = [
  ['15m', 15 * 60_000],
  ['1h', 60 * 60_000],
  ['4h', 4 * 60 * 60_000],
  ['24h', 24 * 60 * 60_000]
] as const;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);

function enqueueRuntimeSnapshot(
  mirrorRuntime: MirrorRuntime | undefined,
  report: Parameters<typeof toRuntimeSnapshotEvent>[0],
  accountState?: LiveAccountState
) {
  if (!mirrorRuntime) {
    return;
  }

  mirrorRuntime.enqueue(toRuntimeSnapshotEvent(report, accountState));
}

function buildWatchId(strategy: StrategyId, tokenMint: string, poolAddress: string) {
  return `${strategy}:${tokenMint || 'unknown'}:${poolAddress || 'none'}`;
}

function buildWatchKey(tokenMint: string, poolAddress: string) {
  return `${tokenMint || 'unknown'}:${poolAddress || 'none'}`;
}

function isNonStableMint(mint: string) {
  return mint.length > 0 && mint !== SOL_MINT && !STABLE_MINTS.has(mint);
}

function collectWatchlistCandidates(input: {
  cycleInput?: Omit<LiveCycleInput, 'strategy'>;
  accountState?: LiveAccountState;
}): EvolutionWatchlistCandidate[] {
  const candidates: EvolutionWatchlistCandidate[] = [
    ...((input.cycleInput?.evolutionWatchlistCandidates ?? []).filter((candidate) => candidate.tokenMint.length > 0))
  ];

  for (const token of input.accountState?.walletTokens ?? []) {
    if (token.amount > 0 && isNonStableMint(token.mint)) {
      candidates.push({
        tokenMint: token.mint,
        tokenSymbol: token.symbol ?? '',
        poolAddress: '',
        sourceReason: 'wallet_inventory'
      });
    }
  }

  for (const position of [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ]) {
    if (isNonStableMint(position.mint)) {
      candidates.push({
        tokenMint: position.mint,
        tokenSymbol: '',
        poolAddress: position.poolAddress ?? '',
        sourceReason: 'lp_position'
      });
    }
  }

  return candidates;
}

function mergeTrackedWatchTokens(input: {
  strategy: StrategyId;
  existing: TrackedWatchTokenRecord[];
  candidates: EvolutionWatchlistCandidate[];
  nowIso: string;
}) {
  const merged = new Map(
    input.existing.map((token) => [buildWatchKey(token.tokenMint, token.poolAddress), token] as const)
  );

  for (const candidate of input.candidates) {
    const key = buildWatchKey(candidate.tokenMint, candidate.poolAddress);
    const existing = merged.get(key);

    if (existing) {
      merged.set(key, {
        ...existing,
        tokenSymbol: existing.tokenSymbol || candidate.tokenSymbol,
        sourceReason: existing.sourceReason || candidate.sourceReason,
        lastEvaluatedAt: input.nowIso
      });
      continue;
    }

    merged.set(key, {
      watchId: buildWatchId(input.strategy, candidate.tokenMint, candidate.poolAddress),
      trackedSince: candidate.trackedSince ?? input.nowIso,
      strategyId: input.strategy,
      tokenMint: candidate.tokenMint,
      tokenSymbol: candidate.tokenSymbol,
      poolAddress: candidate.poolAddress,
      sourceReason: candidate.sourceReason,
      firstCapturedAt: candidate.trackedSince ?? input.nowIso,
      lastEvaluatedAt: input.nowIso
    });
  }

  return [...merged.values()];
}

function buildWatchlistSnapshot(input: {
  trackedToken: TrackedWatchTokenRecord;
  accountState?: LiveAccountState;
  cycleInput?: Omit<LiveCycleInput, 'strategy'>;
  observationAt: string;
  windowLabel: string;
}): WatchlistSnapshotRecord {
  const walletToken = (input.accountState?.walletTokens ?? []).find((token) => token.mint === input.trackedToken.tokenMint && token.amount > 0);
  const journalToken = (input.accountState?.journalTokens ?? []).find((token) => token.mint === input.trackedToken.tokenMint && token.amount > 0);
  const lpPosition = [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ].find((position) =>
    position.mint === input.trackedToken.tokenMint
    && (!input.trackedToken.poolAddress || position.poolAddress === input.trackedToken.poolAddress)
  );
  const contextPool = input.cycleInput?.context?.pool ?? {};

  return {
    watchId: input.trackedToken.watchId,
    trackedSince: input.trackedToken.trackedSince,
    strategyId: input.trackedToken.strategyId,
    tokenMint: input.trackedToken.tokenMint,
    tokenSymbol: input.trackedToken.tokenSymbol || walletToken?.symbol || journalToken?.symbol || '',
    poolAddress: input.trackedToken.poolAddress,
    observationAt: input.observationAt,
    windowLabel: input.windowLabel,
    currentValueSol: resolveTrackedCurrentValueSol({
      walletToken,
      journalToken,
      lpPosition
    }),
    liquidityUsd: typeof contextPool.liquidityUsd === 'number' ? contextPool.liquidityUsd : null,
    activeBinId: typeof lpPosition?.activeBinId === 'number' ? lpPosition.activeBinId : null,
    lowerBinId: typeof lpPosition?.lowerBinId === 'number' ? lpPosition.lowerBinId : null,
    upperBinId: typeof lpPosition?.upperBinId === 'number' ? lpPosition.upperBinId : null,
    binCount: typeof lpPosition?.binCount === 'number' ? lpPosition.binCount : null,
    fundedBinCount: typeof lpPosition?.fundedBinCount === 'number' ? lpPosition.fundedBinCount : null,
    solDepletedBins: typeof lpPosition?.solDepletedBins === 'number' ? lpPosition.solDepletedBins : null,
    unclaimedFeeSol: typeof lpPosition?.unclaimedFeeSol === 'number' ? lpPosition.unclaimedFeeSol : null,
    hasInventory: Boolean(walletToken || journalToken),
    hasLpPosition: Boolean(lpPosition),
    sourceReason: input.trackedToken.sourceReason
  };
}

function resolveTrackedCurrentValueSol(input: {
  walletToken?: { currentValueSol?: number } | undefined;
  journalToken?: { currentValueSol?: number } | undefined;
  lpPosition?: { currentValueSol?: number } | undefined;
}) {
  if (typeof input.lpPosition?.currentValueSol === 'number') {
    return input.lpPosition.currentValueSol;
  }

  if (typeof input.walletToken?.currentValueSol === 'number') {
    return input.walletToken.currentValueSol;
  }

  if (typeof input.journalToken?.currentValueSol === 'number') {
    return input.journalToken.currentValueSol;
  }

  return null;
}

async function updateEvolutionWatchlistBestEffort(input: {
  strategy: StrategyId;
  store: Pick<WatchlistStore, 'readTrackedTokens' | 'writeTrackedTokens' | 'readSnapshots' | 'appendSnapshot'>;
  cycleInput?: Omit<LiveCycleInput, 'strategy'>;
  accountState?: LiveAccountState;
  now: Date;
}) {
  const nowIso = input.now.toISOString();

  try {
    const candidates = collectWatchlistCandidates({
      cycleInput: input.cycleInput,
      accountState: input.accountState
    });
    if (candidates.length === 0) {
      return;
    }

    const existingTrackedTokens = await input.store.readTrackedTokens();
    const mergedTrackedTokens = mergeTrackedWatchTokens({
      strategy: input.strategy,
      existing: existingTrackedTokens,
      candidates,
      nowIso
    });

    await input.store.writeTrackedTokens(mergedTrackedTokens);

    const existingSnapshots = await input.store.readSnapshots();
    const existingSnapshotKeys = new Set(
      existingSnapshots.map((snapshot) => `${snapshot.watchId}:${snapshot.windowLabel}`)
    );

    for (const trackedToken of mergedTrackedTokens) {
      const trackedSinceMs = Date.parse(trackedToken.trackedSince);
      if (Number.isNaN(trackedSinceMs)) {
        continue;
      }

      for (const [windowLabel, windowMs] of WATCHLIST_WINDOWS) {
        if (input.now.getTime() - trackedSinceMs < windowMs) {
          continue;
        }

        const snapshotKey = `${trackedToken.watchId}:${windowLabel}`;
        if (existingSnapshotKeys.has(snapshotKey)) {
          continue;
        }

        await input.store.appendSnapshot(
          buildWatchlistSnapshot({
            trackedToken,
            accountState: input.accountState,
            cycleInput: input.cycleInput,
            observationAt: nowIso,
            windowLabel
          })
        );
        existingSnapshotKeys.add(snapshotKey);
      }
    }
  } catch (error) {
    console.warn(
      `[LiveDaemon] Evolution watchlist persistence failed; continuing without watchlist evidence: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isTransientAutoHealableCircuitReason(reason: string) {
  const normalized = reason.trim().toLowerCase();
  return normalized === 'fetch failed' || normalized === 'timeout';
}

function isTransientAutoHealableError(error: unknown) {
  if (error instanceof ExecutionRequestError) {
    return error.operation === 'account' && error.reason === 'timeout';
  }

  return error instanceof Error && isTransientAutoHealableCircuitReason(error.message);
}

function shouldBootstrapTransientAutoHealEligibility(input: {
  runtimeState: {
    mode: RuntimeMode;
    circuitReason: string;
    transientAutoHealEligible?: boolean;
  };
  dependencyHealth: {
    account: {
      consecutiveFailures: number;
      lastFailureReason: string;
    };
  };
  pendingSubmission: boolean;
}) {
  if (input.pendingSubmission) {
    return false;
  }

  if (
    input.runtimeState.mode !== 'circuit_open' &&
    input.runtimeState.mode !== 'recovering'
  ) {
    return false;
  }

  if (input.runtimeState.transientAutoHealEligible) {
    return true;
  }

  if (input.runtimeState.circuitReason === 'fetch failed') {
    return true;
  }

  return input.runtimeState.circuitReason === 'timeout'
    && input.dependencyHealth.account.lastFailureReason === 'timeout'
    && input.dependencyHealth.account.consecutiveFailures > 0;
}

async function resolveEffectiveAccountState(
  cycleInput: Omit<LiveCycleInput, 'strategy'> | undefined,
  fallback?: LiveAccountState
) {
  if (cycleInput?.accountState) {
    return cycleInput.accountState;
  }

  if (cycleInput?.accountProvider) {
    return cycleInput.accountProvider.readState();
  }

  return fallback;
}

async function runPreIngestPendingRecovery(input: {
  pendingSubmissionStore: PendingSubmissionStore;
  pendingSubmission: Awaited<ReturnType<PendingSubmissionStore['read']>>;
  accountProvider?: LiveAccountStateProvider;
  confirmationProvider?: LiveConfirmationProvider;
}) {
  if (!input.pendingSubmission) {
    return {
      pendingSubmission: null,
      effectiveAccountState: undefined as LiveAccountState | undefined,
      recoveryReason: 'clear' as const
    };
  }

  const effectiveAccountState = input.accountProvider
    ? await input.accountProvider.readState()
    : undefined;

  const recovery = await recoverPendingSubmission({
    pendingSubmission: input.pendingSubmission,
    confirmationProvider: input.confirmationProvider,
    accountState: effectiveAccountState
  });

  if (recovery.clearPending) {
    await input.pendingSubmissionStore.clear();
    return {
      pendingSubmission: null,
      effectiveAccountState,
      recoveryReason: recovery.reason
    };
  }

  if (recovery.nextPendingSubmission) {
    await input.pendingSubmissionStore.write(recovery.nextPendingSubmission);
    return {
      pendingSubmission: recovery.nextPendingSubmission,
      effectiveAccountState,
      recoveryReason: recovery.reason
    };
  }

  return {
    pendingSubmission: input.pendingSubmission,
    effectiveAccountState,
    recoveryReason: recovery.reason
  };
}

function nowIso() {
  return new Date().toISOString();
}

function wait(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function hasHotLpSignal(input: {
  cycleInput?: Omit<LiveCycleInput, 'strategy'>;
  accountState?: LiveAccountState;
}) {
  const trader = input.cycleInput?.context?.trader ?? {};
  const lpNetPnlPct = typeof trader.lpNetPnlPct === 'number' ? trader.lpNetPnlPct : undefined;
  const lpSolDepletedBins = typeof trader.lpSolDepletedBins === 'number' ? trader.lpSolDepletedBins : undefined;
  const accountLpPositions = [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ];

  const hotPnl = typeof lpNetPnlPct === 'number'
    && (lpNetPnlPct >= 25 || lpNetPnlPct <= -15);
  const hotBinFromContext = typeof lpSolDepletedBins === 'number' && lpSolDepletedBins >= 63;
  const hotBinFromAccount = accountLpPositions.some((position) =>
    isManageableLpPosition(position) && typeof position.solDepletedBins === 'number' && position.solDepletedBins >= 63
  );

  return hotPnl || hotBinFromContext || hotBinFromAccount;
}

function resolveNextTickDelayMs(input: {
  baseTickIntervalMs: number;
  hotTickIntervalMs: number;
  rateLimitBackoffIntervalMs: number;
  cycleInput?: Omit<LiveCycleInput, 'strategy'>;
  accountState?: LiveAccountState;
  error?: unknown;
}) {
  if (
    input.error instanceof ExecutionRequestError &&
    input.error.operation === 'account' &&
    input.error.reason === 'rate-limited'
  ) {
    return input.rateLimitBackoffIntervalMs;
  }

  if (input.error instanceof Error && /429|rate-limit/i.test(input.error.message)) {
    return input.rateLimitBackoffIntervalMs;
  }

  if (hasHotLpSignal({
    cycleInput: input.cycleInput,
    accountState: input.accountState
  })) {
    return input.hotTickIntervalMs;
  }

  return input.baseTickIntervalMs;
}

async function warmAccountProvider(accountProvider?: LiveAccountStateProvider) {
  if (!accountProvider) {
    return;
  }

  try {
    await accountProvider.readState();
  } catch {
    // Best-effort warmup only; normal tick handling still owns real failures.
  }
}

function applyDerivedRuntimeState(input: {
  currentState: {
    mode: RuntimeMode;
    circuitReason: string;
    cooldownUntil: string;
    transientRecoverySuccessTicks?: number;
    lastHealthyAt: string;
    updatedAt: string;
  };
  derived: ReturnType<typeof deriveRuntimeMode>;
  pendingSubmission: boolean;
  now: string;
}) {
  const shouldKeepCooldown = input.pendingSubmission || input.derived.mode === 'circuit_open';

  return {
    mode: input.derived.mode,
    circuitReason: input.derived.reason === 'healthy' ? '' : input.derived.reason,
    cooldownUntil:
      input.derived.mode === 'circuit_open'
        ? new Date(Date.now() + 5 * 60_000).toISOString()
        : shouldKeepCooldown
          ? input.currentState.cooldownUntil
          : '',
    transientAutoHealEligible: false,
    transientRecoverySuccessTicks: input.derived.mode === 'healthy'
      ? 0
      : input.currentState.transientRecoverySuccessTicks ?? 0,
    lastHealthyAt:
      input.derived.mode === 'healthy'
        ? input.now
        : input.currentState.lastHealthyAt,
    updatedAt: input.now
  };
}

function applyTransientCircuitAutoHeal(input: {
  tickStartState: {
    mode: RuntimeMode;
    circuitReason: string;
    cooldownUntil: string;
    transientAutoHealEligible?: boolean;
    transientRecoverySuccessTicks?: number;
    lastHealthyAt: string;
    updatedAt: string;
  };
  nextState: {
    mode: RuntimeMode;
    circuitReason: string;
    cooldownUntil: string;
    transientRecoverySuccessTicks?: number;
    lastHealthyAt: string;
    updatedAt: string;
  };
  pendingSubmission: boolean;
  now: string;
}) {
  if (input.pendingSubmission) {
    return {
      ...input.nextState,
      transientAutoHealEligible: false,
      transientRecoverySuccessTicks: 0
    };
  }

  if (
    input.nextState.mode === 'flatten_only' ||
    input.nextState.mode === 'paused' ||
    input.nextState.mode === 'degraded'
  ) {
    return {
      ...input.nextState,
      transientAutoHealEligible: false,
      transientRecoverySuccessTicks: 0
    };
  }

  if (
    input.tickStartState.transientAutoHealEligible &&
    (input.tickStartState.mode === 'circuit_open' || input.tickStartState.mode === 'recovering') &&
    isTransientAutoHealableCircuitReason(input.tickStartState.circuitReason)
  ) {
    const successTicks = (input.tickStartState.transientRecoverySuccessTicks ?? 0) + 1;

    if (successTicks >= TRANSIENT_CIRCUIT_RECOVERY_SUCCESS_TICKS) {
      return {
        ...input.nextState,
        mode: 'healthy' as const,
        circuitReason: '',
        cooldownUntil: '',
        transientAutoHealEligible: false,
        transientRecoverySuccessTicks: 0,
        lastHealthyAt: input.now,
        updatedAt: input.now
      };
    }

    return {
      ...input.nextState,
      mode: 'recovering' as const,
      circuitReason: input.tickStartState.circuitReason,
      cooldownUntil: '',
      transientAutoHealEligible: true,
      transientRecoverySuccessTicks: successTicks,
      updatedAt: input.now
    };
  }

  return {
    ...input.nextState,
    transientAutoHealEligible: false,
    transientRecoverySuccessTicks: 0
  };
}

function hasOpenInventory(accountState?: LiveAccountState) {
  return Boolean(
    accountState?.walletTokens?.some((token) => token.amount > 0
      && token.mint !== 'So11111111111111111111111111111111111111112'
      && token.mint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') ||
    accountState?.walletLpPositions?.some((position) =>
      isManageableLpPosition(position)
      &&
      position.mint !== 'So11111111111111111111111111111111111111112'
      && position.mint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  );
}

function inferOpenPositionMetadata(input: {
  accountState?: LiveAccountState;
  activeMint?: string;
  activePoolAddress?: string;
  existingEntrySol?: number;
  existingOpenedAt?: string;
  fallbackOpenedAt?: string;
}) {
  let entrySol = typeof input.existingEntrySol === 'number' ? input.existingEntrySol : undefined;
  let openedAt = input.existingOpenedAt;

  if ((entrySol !== undefined && openedAt) || !input.accountState) {
    return { entrySol, openedAt };
  }

  const lpPosition = (input.accountState.walletLpPositions ?? []).find((position) => {
    if (!isManageableLpPosition(position)) {
      return false;
    }

    return (input.activeMint && position.mint === input.activeMint)
      || (input.activePoolAddress && position.poolAddress === input.activePoolAddress);
  });

  if (lpPosition) {
    return { entrySol, openedAt };
  }

  return { entrySol, openedAt };
}

function resolveBoundLpPosition(input: {
  accountState?: LiveAccountState;
  chainPositionAddress?: string;
  activeMint?: string;
  activePoolAddress?: string;
}) {
  const positions = [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ].filter((position) => isManageableLpPosition(position));

  if (input.chainPositionAddress) {
    const exact = positions.find((position) => position.positionAddress === input.chainPositionAddress);
    if (exact) {
      return exact;
    }
  }

  return positions.find((position) => {
    if (input.activeMint && input.activePoolAddress) {
      return position.mint === input.activeMint && position.poolAddress === input.activePoolAddress;
    }

    if (input.activeMint) {
      return position.mint === input.activeMint;
    }

    if (input.activePoolAddress) {
      return position.poolAddress === input.activePoolAddress;
    }

    return false;
  });
}

function resolvePersistedLpIdentity(input: {
  lifecycleState?: PositionLifecycleState;
  pendingSubmission: Awaited<ReturnType<PendingSubmissionStore['read']>>;
  positionState?: Awaited<ReturnType<RuntimeStateStore['readPositionState']>>;
  accountState?: LiveAccountState;
  activeMint?: string;
  activePoolAddress?: string;
}) {
  const boundPosition = resolveBoundLpPosition({
    accountState: input.accountState,
    chainPositionAddress: input.positionState?.chainPositionAddress || input.pendingSubmission?.chainPositionAddress,
    activeMint: input.activeMint,
    activePoolAddress: input.activePoolAddress
  });
  const chainPositionAddress = boundPosition?.positionAddress
    || input.positionState?.chainPositionAddress
    || input.pendingSubmission?.chainPositionAddress;

  if (input.lifecycleState !== 'open' && input.lifecycleState !== 'open_pending') {
    return {
      openIntentId: undefined,
      positionId: undefined,
      chainPositionAddress: undefined,
      valuationStatus: undefined,
      valuationReason: undefined,
      lastValuationAt: undefined
    };
  }

  return {
    openIntentId: input.pendingSubmission?.openIntentId || input.positionState?.openIntentId,
    positionId: chainPositionAddress
      ? createPositionId({ chainPositionAddress })
      : input.pendingSubmission?.positionId
        || input.positionState?.positionId
        || ((input.activeMint || input.activePoolAddress)
          ? createPositionId({
              poolAddress: input.activePoolAddress,
              tokenMint: input.activeMint
            })
          : undefined),
    chainPositionAddress,
    valuationStatus: boundPosition?.valuationStatus ?? input.positionState?.valuationStatus,
    valuationReason: boundPosition?.valuationReason ?? input.positionState?.valuationReason,
    lastValuationAt: boundPosition?.lastValuationAt ?? input.positionState?.lastValuationAt
  };
}

function resolveLifecycleStateForPersist(input: {
  nextLifecycleState?: PositionLifecycleState;
  previousLifecycleState?: PositionLifecycleState;
  pendingSubmission: boolean;
  accountState?: LiveAccountState;
  lastAction?: string;
  lastReason?: string;
  activeMint?: string;
}): PositionLifecycleState {
  const hasInventory = hasOpenInventory(input.accountState);

  if (input.nextLifecycleState === 'closed' && hasInventory) {
    return 'open';
  }

  if (input.nextLifecycleState) {
    return input.nextLifecycleState;
  }

  const unresolvedOpen = Boolean(input.activeMint) && (
    input.lastReason?.includes('journal-open-unresolved') ||
    input.lastReason?.includes('pending-open:') ||
    input.lastReason?.includes('mint-position-already-active:')
  );
  const lastReason = input.lastReason ?? '';
  const historicalOnly = lastReason.includes('historical-unconfirmed-entry-only') ||
    lastReason.includes('historical-confirmed-entry-only');
  const pendingOpen = input.pendingSubmission && !hasInventory && (
    input.previousLifecycleState === 'open_pending' ||
    input.lastAction === 'add-lp' ||
    input.lastAction === 'deploy' ||
    unresolvedOpen
  );

  if (!input.pendingSubmission && !hasInventory) {
    return 'closed';
  }

  if (historicalOnly) {
    return 'closed';
  }

  if (pendingOpen) {
    return 'open_pending';
  }

  if (unresolvedOpen && (input.pendingSubmission || hasInventory)) {
    return 'open';
  }

  if (hasInventory) {
    return 'open';
  }

  return input.previousLifecycleState ?? 'closed';
}

export async function runLiveDaemon(options: LiveDaemonOptions) {
  const stateRootDir = options.stateRootDir ?? 'state';
  const journalRootDir = options.journalRootDir ?? 'tmp/journals';
  const tickIntervalMs = options.tickIntervalMs ?? 30_000;
  const hotTickIntervalMs = Math.min(options.hotTickIntervalMs ?? 10_000, tickIntervalMs);
  const rateLimitBackoffIntervalMs = options.rateLimitBackoffIntervalMs ?? Math.max(60_000, tickIntervalMs * 2);
  const sleep = options.sleep ?? wait;
  const maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY;
  const buildCycleInput:
    (tickCount: number) => Promise<Omit<LiveCycleInput, 'strategy'>> | Omit<LiveCycleInput, 'strategy'> =
      options.buildCycleInput ?? (() => ({} as Omit<LiveCycleInput, 'strategy'>));
  const alertSink = options.alertSink ?? new NoopAlertSink();
  const mirrorRuntime = options.mirrorRuntime;
  const housekeepingRunner = options.housekeepingRunner;
  const evolutionWatchlistStore = options.evolutionWatchlistStore ?? new WatchlistStore({
    trackedTokensPath: resolveEvolutionPaths(options.strategy, join(stateRootDir, 'evolution')).watchlistTrackedTokensPath,
    snapshotsPath: resolveEvolutionPaths(options.strategy, join(stateRootDir, 'evolution')).watchlistSnapshotsPath
  });
  const evolutionOutcomeStore = options.evolutionOutcomeStore ?? new LiveCycleOutcomeStore(
    resolveEvolutionPaths(options.strategy, join(stateRootDir, 'evolution')).positionOutcomesPath
  );

  const runtimeStateStore = new RuntimeStateStore(stateRootDir);
  const pendingSubmissionStore = new PendingSubmissionStore(stateRootDir);
  let dependencyHealth =
    (await runtimeStateStore.readDependencyHealth()) ?? createDependencyHealthSnapshot();
  let runtimeState = (await runtimeStateStore.readRuntimeState()) ?? {
    mode: 'healthy' as RuntimeMode,
    circuitReason: '',
    cooldownUntil: '',
    transientAutoHealEligible: false,
    transientRecoverySuccessTicks: 0,
    lastHealthyAt: '',
    updatedAt: nowIso()
  };
  let tickCount = 0;

  await mirrorRuntime?.start();
  await warmAccountProvider(options.accountProvider);

  try {
    while (tickCount < maxTicks) {
      tickCount += 1;
      let cycleInput: Omit<LiveCycleInput, 'strategy'> | undefined;
      let effectiveAccountState: LiveAccountState | undefined;
      let tickError: unknown;
      let pendingSubmission = await pendingSubmissionStore.read();
      let pendingSubmissionBeforeCycle = pendingSubmission;
      let positionState = await runtimeStateStore.readPositionState() ?? undefined;
      let previousMode = runtimeState.mode;
      const tickStartRuntimeState = {
        ...runtimeState,
        transientAutoHealEligible: shouldBootstrapTransientAutoHealEligibility({
          runtimeState,
          dependencyHealth,
          pendingSubmission: pendingSubmission !== null
        }),
        transientRecoverySuccessTicks: runtimeState.transientRecoverySuccessTicks ?? 0
      };

      try {
        const preRecovery = await runPreIngestPendingRecovery({
          pendingSubmissionStore,
          pendingSubmission,
          accountProvider: options.accountProvider,
          confirmationProvider: options.confirmationProvider
        });
        pendingSubmission = preRecovery.pendingSubmission;
        effectiveAccountState = preRecovery.effectiveAccountState;
        positionState = await runtimeStateStore.readPositionState() ?? undefined;
        if (
          pendingSubmission === null &&
          effectiveAccountState &&
          hasOpenInventory(effectiveAccountState) &&
          (preRecovery.recoveryReason === 'pending-submission-filled' || preRecovery.recoveryReason === 'pending-submission-confirmed')
        ) {
          positionState = positionState
            ? {
                ...positionState,
                lifecycleState: 'open'
              }
            : {
                allowNewOpens: true,
                flattenOnly: false,
                lastAction: 'hold',
                lifecycleState: 'open',
                updatedAt: nowIso()
              };
        }

        const cooldownActive = pendingSubmission !== null && runtimeState.cooldownUntil !== '' && runtimeState.cooldownUntil > nowIso();
        const derived = deriveRuntimeMode({
          currentMode: runtimeState.mode,
          quoteFailures: dependencyHealth.quote.consecutiveFailures,
          reconcileFailures: dependencyHealth.account.consecutiveFailures,
          hasUnknownSubmissionOutcome: pendingSubmission?.confirmationStatus === 'unknown',
          cooldownActive,
          flattenOnlyRequested: runtimeState.mode === 'flatten_only'
        });
        previousMode = runtimeState.mode;

        const hasPendingSubmission = pendingSubmission !== null;
        runtimeState = applyDerivedRuntimeState({
          currentState: runtimeState,
          derived,
          pendingSubmission: hasPendingSubmission,
          now: nowIso()
        });

        cycleInput = await buildCycleInput(tickCount);
        effectiveAccountState = await resolveEffectiveAccountState(cycleInput, effectiveAccountState);
        pendingSubmission = await pendingSubmissionStore.read();
        pendingSubmissionBeforeCycle = pendingSubmission;
        positionState = await runtimeStateStore.readPositionState() ?? undefined;
        let runtimeStateExplicitlySet = false;
        const confirmationProvider = cycleInput.confirmationProvider ?? options.confirmationProvider;
        const evolutionSink = cycleInput.evolutionSink ?? evolutionOutcomeStore;

        const result = await runLiveCycle({
          strategy: options.strategy,
          journalRootDir,
          stateRootDir,
          runtimeMode: runtimeState.mode,
          mirrorSink: mirrorRuntime,
          positionState,
          ...cycleInput,
          evolutionSink,
          accountState: effectiveAccountState
        });

        await updateEvolutionWatchlistBestEffort({
          strategy: options.strategy,
          store: evolutionWatchlistStore,
          cycleInput,
          accountState: effectiveAccountState,
          now: new Date()
        });

        if (result.failureKind && result.failureSource) {
          const dependencyKey = result.failureSource === 'broadcast'
            ? 'broadcaster'
            : result.failureSource === 'signer'
              ? 'signer'
              : result.failureSource === 'confirmation'
                ? 'confirmation'
                : result.failureSource === 'account'
                  ? 'account'
                  : result.failureSource === 'quote'
                    ? 'quote'
                    : null;

          if (dependencyKey) {
            dependencyHealth = markDependencyFailure(
              dependencyHealth,
              dependencyKey,
              result.reason,
              nowIso()
            );
          }

          if (result.failureKind === 'unknown') {
            runtimeState = {
              ...runtimeState,
              mode: 'circuit_open',
              circuitReason: result.reason,
              cooldownUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
              transientAutoHealEligible: false,
              transientRecoverySuccessTicks: 0,
              updatedAt: nowIso()
            };
            runtimeStateExplicitlySet = true;
          }
        }

        if (result.failureSource === 'recovery') {
          const hasPendingSubmission = (await pendingSubmissionStore.read()) !== null;
          runtimeState = {
            ...runtimeState,
            mode:
              result.reason === 'pending-submission-timeout' && hasPendingSubmission
                ? 'circuit_open'
                : hasPendingSubmission
                  ? 'recovering'
                  : 'healthy',
            circuitReason: hasPendingSubmission ? result.reason : '',
            cooldownUntil:
              result.reason === 'pending-submission-timeout' && hasPendingSubmission
                ? new Date(Date.now() + 5 * 60_000).toISOString()
                : hasPendingSubmission
                  ? runtimeState.cooldownUntil
                  : '',
            transientAutoHealEligible: false,
            transientRecoverySuccessTicks: 0,
            lastHealthyAt: !hasPendingSubmission ? nowIso() : runtimeState.lastHealthyAt,
            updatedAt: nowIso()
          };
          runtimeStateExplicitlySet = true;
        }

        if (result.quoteCollected) {
          dependencyHealth = markDependencySuccess(dependencyHealth, 'quote', nowIso());
        }

        if (result.liveOrderSubmitted) {
          dependencyHealth = markDependencySuccess(dependencyHealth, 'signer', nowIso());
          dependencyHealth = markDependencySuccess(dependencyHealth, 'broadcaster', nowIso());
        }

        if (confirmationProvider && result.confirmationStatus && result.confirmationStatus !== 'unknown') {
          dependencyHealth = markDependencySuccess(dependencyHealth, 'confirmation', nowIso());
        }

        if ((cycleInput.accountProvider || effectiveAccountState) && result.reason !== 'balance-mismatch') {
          dependencyHealth = markDependencySuccess(dependencyHealth, 'account', nowIso());
        }

        if (result.reason === 'balance-mismatch') {
          dependencyHealth = markDependencyFailure(
            dependencyHealth,
            'account',
            result.reason,
            nowIso()
          );
        }

        let postTickPendingSubmission = await pendingSubmissionStore.read();
        if (postTickPendingSubmission && effectiveAccountState) {
          const postTickRecovery = await recoverPendingSubmission({
            pendingSubmission: postTickPendingSubmission,
            confirmationProvider,
            accountState: effectiveAccountState
          });

          if (postTickRecovery.clearPending) {
            await pendingSubmissionStore.clear();
            postTickPendingSubmission = null;
          } else if (postTickRecovery.nextPendingSubmission) {
            await pendingSubmissionStore.write(postTickRecovery.nextPendingSubmission);
            postTickPendingSubmission = postTickRecovery.nextPendingSubmission;
          }
        }

        if (!runtimeStateExplicitlySet) {
          const postTickDerived = deriveRuntimeMode({
            currentMode: runtimeState.mode,
            quoteFailures: dependencyHealth.quote.consecutiveFailures,
            reconcileFailures: dependencyHealth.account.consecutiveFailures,
            hasUnknownSubmissionOutcome: postTickPendingSubmission?.confirmationStatus === 'unknown',
            cooldownActive:
              postTickPendingSubmission !== null &&
              runtimeState.cooldownUntil !== '' &&
              runtimeState.cooldownUntil > nowIso(),
            flattenOnlyRequested: runtimeState.mode === 'flatten_only'
          });

          runtimeState = applyDerivedRuntimeState({
            currentState: runtimeState,
            derived: postTickDerived,
            pendingSubmission: postTickPendingSubmission !== null,
            now: nowIso()
          });
        }

        runtimeState = applyTransientCircuitAutoHeal({
          tickStartState: tickStartRuntimeState,
          nextState: runtimeState,
          pendingSubmission: postTickPendingSubmission !== null,
          now: nowIso()
        });

        const housekeeping = housekeepingRunner
          ? await housekeepingRunner.runIfDue()
          : undefined;

        const report = buildHealthReport({
          mode: runtimeState.mode,
          allowNewOpens:
            runtimeState.mode === 'healthy' || runtimeState.mode === 'degraded',
          flattenOnly: runtimeState.mode === 'flatten_only',
          pendingSubmission: (await pendingSubmissionStore.read()) !== null,
          circuitReason: runtimeState.circuitReason,
          lastSuccessfulTickAt: nowIso(),
          dependencyHealth: {
            quoteFailures: dependencyHealth.quote.consecutiveFailures,
            reconcileFailures: dependencyHealth.account.consecutiveFailures
          },
          housekeeping,
          mirror: mirrorRuntime?.snapshot()
        });

        await runtimeStateStore.writeRuntimeState(runtimeState);
        await runtimeStateStore.writeDependencyHealth(dependencyHealth);
        const persistedActiveMint = typeof result.context?.token?.mint === 'string' ? result.context.token.mint : '';
        const persistedPendingSubmission = await pendingSubmissionStore.read();
        const persistedLifecycleState = resolveLifecycleStateForPersist({
          nextLifecycleState: result.nextLifecycleState,
          previousLifecycleState: positionState?.lifecycleState,
          pendingSubmission: persistedPendingSubmission !== null,
          accountState: effectiveAccountState,
          lastAction: result.action,
          lastReason: result.reason,
          activeMint: persistedActiveMint
        });

        const failedOpenCooldownMint = result.reason.startsWith('failed-open-cooldown:')
          ? result.reason.slice('failed-open-cooldown:'.length)
          : '';
        const shouldRecordClosedMint = isExposureReducingAction(result.action) || failedOpenCooldownMint.length > 0;
        const closedMint = shouldRecordClosedMint
          ? (failedOpenCooldownMint || persistedActiveMint)
          : (positionState?.lastClosedMint ?? '');
        const closedAt = shouldRecordClosedMint ? nowIso() : (positionState?.lastClosedAt ?? '');
        const persistedPoolAddress = typeof result.context?.pool?.address === 'string' && result.context.pool.address.length > 0
          ? result.context.pool.address
          : (positionState?.activePoolAddress ?? '');
        const persistedEntrySol = result.action === 'add-lp' && result.liveOrderSubmitted
          ? cycleInput?.requestedPositionSol
          : isExposureReducingAction(result.action)
            ? undefined
            : positionState?.entrySol;
        const persistedOpenedAt = result.action === 'add-lp' && result.liveOrderSubmitted
          ? nowIso()
          : isExposureReducingAction(result.action)
            ? undefined
            : positionState?.openedAt;
        const persistedIdentity = resolvePersistedLpIdentity({
          lifecycleState: persistedLifecycleState,
          pendingSubmission: persistedPendingSubmission ?? pendingSubmissionBeforeCycle,
          positionState,
          accountState: effectiveAccountState,
          activeMint: persistedActiveMint,
          activePoolAddress: persistedPoolAddress
        });
        const inferredPositionMetadata = persistedLifecycleState === 'open'
          ? inferOpenPositionMetadata({
              accountState: effectiveAccountState,
              activeMint: persistedActiveMint,
              activePoolAddress: persistedPoolAddress,
              existingEntrySol: persistedEntrySol,
              existingOpenedAt: persistedOpenedAt,
              fallbackOpenedAt: nowIso()
            })
          : { entrySol: persistedEntrySol, openedAt: persistedOpenedAt };
        const orphanedIdentity = persistedLifecycleState === 'open'
          && !inferredPositionMetadata.entrySol
          && !inferredPositionMetadata.openedAt
          && (persistedIdentity.chainPositionAddress || persistedIdentity.positionId || persistedIdentity.openIntentId)
          ? markOrphanedLpPosition({
              openIntentId: persistedIdentity.openIntentId,
              positionId: persistedIdentity.positionId,
              chainPositionAddress: persistedIdentity.chainPositionAddress,
              poolAddress: persistedPoolAddress,
              tokenMint: persistedActiveMint,
              valuationStatus: persistedIdentity.valuationStatus,
              valuationReason: persistedIdentity.valuationReason,
              lastValuationAt: persistedIdentity.lastValuationAt
            })
          : null;
        await runtimeStateStore.writePositionState({
          allowNewOpens: runtimeState.mode === 'healthy' || runtimeState.mode === 'degraded',
          flattenOnly: runtimeState.mode === 'flatten_only',
          lastAction: result.action,
          lastReason: result.reason,
          openIntentId: persistedIdentity.openIntentId,
          positionId: persistedIdentity.positionId,
          chainPositionAddress: persistedIdentity.chainPositionAddress,
          activeMint: persistedActiveMint,
          activePoolAddress: persistedPoolAddress,
          lifecycleState: persistedLifecycleState,
          entrySol: orphanedIdentity?.entrySol ?? inferredPositionMetadata.entrySol,
          openedAt: orphanedIdentity?.openedAt ?? inferredPositionMetadata.openedAt,
          valuationStatus: orphanedIdentity?.valuationStatus ?? persistedIdentity.valuationStatus,
          valuationReason: orphanedIdentity?.valuationReason ?? persistedIdentity.valuationReason,
          lastValuationAt: orphanedIdentity?.lastValuationAt ?? persistedIdentity.lastValuationAt,
          lastClosedMint: closedMint,
          lastClosedAt: closedAt,
          walletSol: effectiveAccountState?.walletSol,
          updatedAt: nowIso()
        });
        await runtimeStateStore.writeHealthReport(report);
        enqueueRuntimeSnapshot(mirrorRuntime, report, effectiveAccountState);
        await mirrorRuntime?.flushOnce();

        if (mirrorRuntime) {
          const caughtUpEvents = await enqueueMirrorCatchupFromJournals({
            strategyId: options.strategy,
            stateRootDir,
            journalRootDir,
            mirrorRuntime
          });

          if (caughtUpEvents > 0) {
            await mirrorRuntime.flushOnce();
          }
        }

        if (shouldSendAlert({
          previousMode,
          nextMode: runtimeState.mode,
          reason: runtimeState.circuitReason
        })) {
          await alertSink.send({
            previousMode,
            nextMode: runtimeState.mode,
            reason: runtimeState.circuitReason,
            sentAt: nowIso()
          });
        }
      } catch (error) {
        tickError = error;
        const now = nowIso();

        if (error instanceof ExecutionRequestError) {
          const dependencyKey = error.operation === 'broadcast'
            ? 'broadcaster'
            : error.operation === 'signer'
              ? 'signer'
              : error.operation === 'confirmation'
                ? 'confirmation'
                : error.operation === 'account'
                  ? 'account'
                  : 'quote';

          dependencyHealth = markDependencyFailure(
            dependencyHealth,
            dependencyKey,
            error.reason,
            now
          );
        }

        const transientAutoHealEligible = isTransientAutoHealableError(error);
        runtimeState = {
          ...runtimeState,
          mode: 'circuit_open',
          circuitReason: error instanceof Error ? error.message : String(error),
          cooldownUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
          transientAutoHealEligible,
          transientRecoverySuccessTicks: 0,
          updatedAt: now
        };

        const report = buildHealthReport({
          mode: runtimeState.mode,
          allowNewOpens: false,
          flattenOnly: runtimeState.mode === 'flatten_only',
          pendingSubmission: (await pendingSubmissionStore.read()) !== null,
          circuitReason: runtimeState.circuitReason,
          lastSuccessfulTickAt: runtimeState.lastHealthyAt,
          dependencyHealth: {
            quoteFailures: dependencyHealth.quote.consecutiveFailures,
            reconcileFailures: dependencyHealth.account.consecutiveFailures
          },
          housekeeping: housekeepingRunner?.snapshot(),
          mirror: mirrorRuntime?.snapshot(),
          updatedAt: now
        });

        await runtimeStateStore.writeRuntimeState(runtimeState);
        await runtimeStateStore.writeDependencyHealth(dependencyHealth);
        const persistedPendingSubmission = await pendingSubmissionStore.read();
        const persistedLifecycleState = resolveLifecycleStateForPersist({
          previousLifecycleState: positionState?.lifecycleState,
          pendingSubmission: persistedPendingSubmission !== null,
          accountState: effectiveAccountState
        });
        const persistedIdentity = resolvePersistedLpIdentity({
          lifecycleState: persistedLifecycleState,
          pendingSubmission: persistedPendingSubmission,
          positionState,
          accountState: effectiveAccountState,
          activeMint: positionState?.activeMint,
          activePoolAddress: positionState?.activePoolAddress
        });
        await runtimeStateStore.writePositionState({
          allowNewOpens: false,
          flattenOnly: runtimeState.mode === 'flatten_only',
          lastAction: 'hold',
          activeMint: positionState?.activeMint,
          openIntentId: persistedIdentity.openIntentId,
          positionId: persistedIdentity.positionId,
          chainPositionAddress: persistedIdentity.chainPositionAddress,
          activePoolAddress: positionState?.activePoolAddress,
          lifecycleState: persistedLifecycleState,
          entrySol: positionState?.entrySol,
          openedAt: positionState?.openedAt,
          valuationStatus: persistedIdentity.valuationStatus,
          valuationReason: persistedIdentity.valuationReason,
          lastValuationAt: persistedIdentity.lastValuationAt,
          lastClosedMint: positionState?.lastClosedMint,
          lastClosedAt: positionState?.lastClosedAt,
          updatedAt: now
        });
        await runtimeStateStore.writeHealthReport(report);
        enqueueRuntimeSnapshot(mirrorRuntime, report, effectiveAccountState);
        await mirrorRuntime?.flushOnce();

        if (shouldSendAlert({
          previousMode,
          nextMode: runtimeState.mode,
          reason: runtimeState.circuitReason
        })) {
          await alertSink.send({
            previousMode,
            nextMode: runtimeState.mode,
            reason: runtimeState.circuitReason,
            sentAt: now
          });
        }
      }

      if (tickCount < maxTicks) {
        const delayMs = resolveNextTickDelayMs({
          baseTickIntervalMs: tickIntervalMs,
          hotTickIntervalMs,
          rateLimitBackoffIntervalMs,
          cycleInput,
          accountState: effectiveAccountState,
          error: tickError
        });
        await sleep(delayMs);
      }
    }
  } finally {
    await mirrorRuntime?.stop();
  }

  return {
    tickCount,
    stateRootDir,
    journalRootDir
  };
}
