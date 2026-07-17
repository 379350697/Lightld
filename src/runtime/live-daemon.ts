import { join } from 'node:path';

import { createDependencyHealthSnapshot, markDependencyFailure, markDependencySuccess } from './dependency-health.ts';
import { buildHealthReport } from './health-report.ts';
import { enqueueMirrorCatchupFromJournals } from '../observability/mirror-catchup.ts';
import {
  buildOrderMirrorPayload,
  toFillMirrorEvent,
  toIncidentMirrorEvent,
  toOrderMirrorEvent,
  toRuntimeSnapshotEvent
} from '../observability/mirror-adapters.ts';
import type { MirrorRuntime } from '../observability/mirror-runtime.ts';
import { readRotatedJsonLines } from '../journals/jsonl-writer.ts';
import { LiveFillJournal } from '../journals/live-fill-journal.ts';
import { LiveIncidentJournal } from '../journals/live-incident-journal.ts';
import {
  LiveCycleOutcomeStore,
  WatchlistStore,
  resolveEvolutionPaths,
  type EvolutionWatchlistCandidate,
  type TrackedWatchTokenRecord,
  type WatchlistSnapshotRecord
} from '../evolution/index.ts';
import { PendingSubmissionStore } from './pending-submission-store.ts';
import {
  PreparedBroadcastStore,
  buildPreparedBroadcastSnapshot,
  recoverPreparedBroadcast
} from './prepared-broadcast-store.ts';
import { RuntimeStateStore } from './runtime-state-store.ts';
import { deriveRuntimeMode } from './runtime-mode-policy.ts';
import { runLiveCycle, type LiveCycleConfirmedFill, type LiveCycleInput, type LiveCycleResult, type StrategyId } from './live-cycle.ts';
import { recoverPendingSubmission } from './pending-submission-recovery.ts';
import type {
  LifecycleEventRecord,
  PendingSubmissionSnapshot,
  PositionLedgerSnapshot,
  PositionLifecycleState,
  PositionStateSnapshot,
  RuntimeMode,
  TargetOpenCooldownSnapshot
} from './state-types.ts';
import { classifyAction, isExposureReducingAction, isFullExitAction, type LiveAction } from './action-semantics.ts';
import type { LiveAccountState, LiveAccountStateProvider } from './live-account-provider.ts';
import type { HousekeepingRunner } from './housekeeping.ts';
import type { AlertSink } from './alert-sink.ts';
import { NoopAlertSink, shouldSendAlert } from './alert-sink.ts';
import { ExecutionRequestError } from '../execution/error-classification.ts';
import type { LiveConfirmationProvider } from '../execution/live-confirmation-provider.ts';
import { buildOrderIntent } from '../execution/order-intent-builder.ts';
import { isManageableLpPosition } from './lp-position-visibility.ts';
import { createPositionId, markOrphanedLpPosition } from './lp-position-record.ts';
import { ResidualTokenSweepStore } from './residual-token-sweep-store.ts';
import { TargetOpenCooldownStore } from './target-open-cooldown-store.ts';
import { hasActionableTokenAmount } from './token-inventory.ts';
import {
  hasCompleteFreshAccountSnapshot,
  hasFreshCompleteLpExitAbsenceEvidence
} from './pending-submission-wallet-evidence.ts';
import { DEFAULT_SOL_DEPLETION_EXIT_BINS } from './lp-sol-exposure.ts';
import {
  isTrustedEntrySolSource,
  isTrustedFillAmountSource,
  resolveTrustedEntryFromFills,
  type TrustedLpEntryResolution
} from './lp-entry-resolver.ts';
import type { LpEntryEvidenceProvider } from './lp-entry-evidence-provider.ts';
import { SpendingLimitsStore, type SpendingLimitsConfig } from '../risk/spending-limits.ts';
import { classifyIncidentReason } from './incident-taxonomy.ts';
import { buildExecutionLifecycleKey } from './execution-lifecycle-key.ts';
import {
  isPositionAlreadyClosedTerminal,
  resolvePositionBusinessSemantics,
  type PositionBusinessSemantics
} from './position-business-semantics.ts';
import { buildLifecycleProjection, buildOrderAttemptRecord } from './lifecycle-projection.ts';
import { UNBOUND_ACCOUNT_LP_REASON } from './lp-ownership.ts';
import {
  applyLiveCycleResultToLedger,
  collectActiveLpPositions,
  importActiveLpPositionsToLedger,
  positionLedgerKey,
  selectCompatibilityPositionState,
  summarizePositionLedger
} from './position-ledger.ts';

type LiveDaemonBuildCycleContext = {
  tickCount: number;
  positionState?: PositionStateSnapshot;
  positionLedger?: PositionLedgerSnapshot;
  accountState?: LiveAccountState;
  selectionMode?: 'default' | 'maintenance-only' | 'new-open-only';
  skipMints?: string[];
  openCooldowns?: TargetOpenCooldownSnapshot[];
};

function lifecycleEventKey(input: {
  result: LiveCycleResult;
  eventType: LifecycleEventRecord['eventType'];
  suffix?: string;
}) {
  return [
    input.result.orderIntent?.idempotencyKey,
    input.result.actionIdentity?.chainPositionAddress,
    input.result.actionIdentity?.openIntentId,
    input.result.action,
    input.eventType,
    input.suffix
  ].filter(Boolean).join(':');
}

function buildLifecycleEventsFromResult(input: {
  strategyId: StrategyId;
  result: LiveCycleResult;
  now: string;
  fullExitClosureProven?: boolean;
}): LifecycleEventRecord[] {
  const { result } = input;
  const identity = result.actionIdentity;
  const intent = result.orderIntent;
  if (!identity && !intent) {
    return [];
  }
  const submittedBroadcast = result.broadcastResult?.status === 'submitted'
    ? result.broadcastResult
    : undefined;

  const common = {
    strategyId: input.strategyId,
    openIntentId: identity?.openIntentId,
    positionId: identity?.positionId,
    chainPositionAddress: identity?.chainPositionAddress,
    idempotencyKey: intent?.idempotencyKey,
    action: result.action,
    poolAddress: intent?.poolAddress
      || (typeof result.context?.pool?.address === 'string' ? result.context.pool.address : undefined),
    tokenMint: intent?.tokenMint
      || (typeof result.context?.token?.mint === 'string' ? result.context.token.mint : undefined),
    reason: result.reason,
    detail: 'failureDetail' in result && typeof result.failureDetail === 'string'
      ? result.failureDetail
      : undefined
  };
  const events: LifecycleEventRecord[] = [];
  const push = (eventType: LifecycleEventRecord['eventType'], suffix?: string, extra: Partial<LifecycleEventRecord> = {}) => {
    events.push({
      ...common,
      ...extra,
      eventType,
      eventKey: lifecycleEventKey({ result, eventType, suffix }),
      createdAt: input.now
    });
  };

  if ((result.action === 'add-lp' || result.action === 'deploy') && identity?.openIntentId) {
    push('OpenIntentCreated', 'intent');
  }

  if (isFullExitAction(result.action as LiveAction)) {
    push('CloseIntentCreated', 'intent');
  }

  if (!result.liveOrderSubmitted) {
    push(result.failureSource === 'signer' ? 'OrderSignFailed' : 'BroadcastNotSubmitted', result.reason);
    return events;
  }

  push('BroadcastSubmitted', submittedBroadcast?.submissionId, {
    submissionId: submittedBroadcast?.submissionId,
    confirmationSignature: submittedBroadcast?.confirmationSignature
  });

  if (result.confirmationStatus) {
    push('ConfirmationResolved', result.confirmationStatus, {
      submissionId: submittedBroadcast?.submissionId,
      confirmationSignature: submittedBroadcast?.confirmationSignature
    });
  }

  if (result.confirmedFill) {
    push('FillObserved', result.confirmedFill.submissionId, {
      submissionId: result.confirmedFill.submissionId
    });
  }

  if ((result.action === 'add-lp' || result.action === 'deploy') && identity?.chainPositionAddress) {
    push('ChainPositionObserved', identity.chainPositionAddress);
  }

  if (isFullExitAction(result.action as LiveAction) && input.fullExitClosureProven === true) {
    push('PositionClosed', identity?.chainPositionAddress ?? submittedBroadcast?.submissionId);
  }

  if (submittedBroadcast?.residualSweepStatus === 'incomplete') {
    push('ResidualCleanupRequired', 'residual', {
      residualCleanupStatus: 'residual_cleanup_pending',
      residualCleanupValueSol: submittedBroadcast.residualEstimatedValueSol
    });
  }

  return events;
}

function residualCleanupStatusFromResult(result: LiveCycleResult) {
  const submittedBroadcast = result.broadcastResult?.status === 'submitted'
    ? result.broadcastResult
    : undefined;
  if (submittedBroadcast?.residualSweepStatus === 'incomplete') {
    return 'residual_cleanup_pending';
  }
  if (submittedBroadcast?.residualSweepStatus === 'complete') {
    return 'residual_cleanup_complete';
  }
  if (submittedBroadcast?.residualSweepStatus === 'dust_ignored') {
    return 'residual_dust_ignored';
  }
  return undefined;
}

function residualCleanupAmountRawFromResult(result: LiveCycleResult) {
  if (result.broadcastResult?.status !== 'submitted') {
    return undefined;
  }
  const mint = result.orderIntent?.tokenMint;
  if (!mint) {
    return undefined;
  }
  return result.broadcastResult.residualUnsoldAmountsRaw?.[mint];
}

function residualCleanupValueFromResult(result: LiveCycleResult) {
  const submittedBroadcast = result.broadcastResult?.status === 'submitted'
    ? result.broadcastResult
    : undefined;
  return submittedBroadcast?.residualEstimatedValueSol;
}

type LiveDaemonOptions = {
  strategy: StrategyId;
  captureMode?: NonNullable<LiveCycleInput['captureMode']>;
  spendingLimitsConfig?: SpendingLimitsConfig;
  stateRootDir?: string;
  journalRootDir?: string;
  tickIntervalMs?: number;
  hotTickIntervalMs?: number;
  rateLimitBackoffIntervalMs?: number;
  residualTokenSweepIntervalMs?: number;
  residualTokenSweepCooldownMs?: number;
  residualTokenSweepMinValueSol?: number;
  residualSweepMaxSlippageBps?: number;
  residualSweepMaxImpactBps?: number;
  maxTicks?: number;
  buildCycleInput?: (
    tickCount: number,
    context?: LiveDaemonBuildCycleContext
  ) => Promise<Omit<LiveCycleInput, 'strategy'>> | Omit<LiveCycleInput, 'strategy'>;
  alertSink?: AlertSink;
  mirrorRuntime?: MirrorRuntime;
  housekeepingRunner?: HousekeepingRunner;
  accountProvider?: LiveAccountStateProvider;
  signer?: Omit<LiveCycleInput, 'strategy'>['signer'];
  broadcaster?: Omit<LiveCycleInput, 'strategy'>['broadcaster'];
  confirmationProvider?: LiveConfirmationProvider;
  lpEntryEvidenceProvider?: LpEntryEvidenceProvider;
  maxActivePositions?: number;
  openAfterMaintenanceHold?: boolean;
  evolutionWatchlistStore?: Pick<WatchlistStore, 'readTrackedTokens' | 'writeTrackedTokens' | 'readSnapshots' | 'appendSnapshot'>;
  evolutionOutcomeStore?: Pick<LiveCycleOutcomeStore, 'appendOutcome'>;
  onCycleResult?: (result: LiveCycleResult) => Promise<void> | void;
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
const DEFAULT_RESIDUAL_TOKEN_SWEEP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RESIDUAL_TOKEN_SWEEP_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_RESIDUAL_TOKEN_SWEEP_MIN_VALUE_SOL = 0.1;
const LP_ENTRY_EVIDENCE_COOLDOWN_MS = 10 * 60_000;
const BAD_EXIT_REOPEN_COOLDOWN_MS = 60 * 60_000;
const RECENT_CLOSE_RECONCILE_COOLDOWN_MS = 2 * 60_000;

type TrustedLpEntryMetadata = {
  entrySol?: number;
  entrySolSource?: PositionStateSnapshot['entrySolSource'];
  entryFillSubmissionId?: string;
  openedAt?: string;
};

type RuntimeFillEntry = NonNullable<LiveAccountState['fills']>[number];

type JournalFillEntry = {
  submissionId?: string;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
  mint?: string;
  tokenMint?: string;
  side?: string;
  amount?: number;
  filledSol?: number;
  actualFilledSol?: number;
  fillAmountSource?: string;
  hasFillEvidence?: boolean;
  recordedAt?: string;
};

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

function enqueueResolvedOpenOrderMirror(input: {
  mirrorRuntime?: MirrorRuntime;
  idempotencyKey?: string;
  cycleId: string;
  strategyId: StrategyId;
  openIntentId?: string;
  chainPositionAddress?: string;
  poolAddress?: string;
  tokenMint?: string;
  tokenSymbol?: string;
  createdAt?: string;
  updatedAt: string;
}) {
  if (
    !input.mirrorRuntime ||
    !input.idempotencyKey ||
    !input.chainPositionAddress ||
    !input.poolAddress ||
    !input.tokenMint ||
    !input.createdAt
  ) {
    return;
  }

  input.mirrorRuntime.enqueue(toOrderMirrorEvent(buildOrderMirrorPayload({
    idempotencyKey: input.idempotencyKey,
    lifecycleKey: `chain-position:${input.chainPositionAddress}`,
    cycleId: input.cycleId,
    strategyId: input.strategyId,
    submissionId: '',
    openIntentId: input.openIntentId,
    positionId: input.chainPositionAddress,
    chainPositionAddress: input.chainPositionAddress,
    confirmationSignature: '',
    poolAddress: input.poolAddress,
    tokenMint: input.tokenMint,
    tokenSymbol: input.tokenSymbol ?? '',
    action: 'add-lp',
    requestedPositionSol: 0,
    quotedOutputSol: 0,
    broadcastStatus: 'submitted',
    confirmationStatus: 'confirmed',
    finality: 'confirmed',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  })));
}

async function appendDaemonIncident(input: {
  mirrorRuntime?: MirrorRuntime;
  strategyId: StrategyId;
  journalRootDir: string;
  runtimeMode: RuntimeMode;
  stage: string;
  reason: string;
  tokenMint?: string;
  tokenSymbol?: string;
  poolAddress?: string;
  chainPositionAddress?: string;
}) {
  const recordedAt = nowIso();
  const classification = classifyIncidentReason(input.reason);
  const cycleId = `${input.strategyId}:${recordedAt}`;
  const incidentId = `${cycleId}:${input.stage}`;
  const journal = new LiveIncidentJournal(join(input.journalRootDir, `${input.strategyId}-live-incidents.jsonl`), {
    rotateDaily: true,
    retentionDays: 30,
    now: () => new Date(recordedAt)
  });

  await journal.append({
    cycleId,
    strategyId: input.strategyId,
    stage: input.stage,
    severity: classification.severity ?? 'warning',
    kind: classification.kind,
    reason: input.reason,
    rootCause: classification.rootCause,
    suggestedAction: classification.suggestedAction,
    poolAddress: input.poolAddress,
    tokenMint: input.tokenMint,
    tokenSymbol: input.tokenSymbol,
    chainPositionAddress: input.chainPositionAddress,
    runtimeMode: input.runtimeMode,
    recordedAt
  });

  input.mirrorRuntime?.enqueue(toIncidentMirrorEvent({
    lifecycleKey: input.chainPositionAddress
      ? `chain-position:${input.chainPositionAddress}`
      : undefined,
    incidentId,
    cycleId,
    stage: input.stage,
    severity: classification.severity ?? 'warning',
    reason: input.reason,
    runtimeMode: input.runtimeMode,
    submissionId: '',
    tokenMint: input.tokenMint ?? '',
    tokenSymbol: input.tokenSymbol ?? '',
    recordedAt
  }));
}

async function appendReconstructedEntryFill(input: {
  mirrorRuntime?: MirrorRuntime;
  strategyId: StrategyId;
  journalRootDir: string;
  cycleId: string;
  positionState: PositionStateSnapshot;
  entrySol: number;
  openedAt: string;
  signature: string;
}) {
  const lifecycleKey = buildExecutionLifecycleKey({
    tokenMint: input.positionState.activeMint ?? '',
    openIntentId: input.positionState.openIntentId,
    positionId: input.positionState.positionId,
    chainPositionAddress: input.positionState.chainPositionAddress
  });
  const fillId = `${input.signature}:${input.openedAt}:chain-reconstructed`;
  const fillEntry = {
    lifecycleKey,
    cycleId: input.cycleId,
    submissionId: input.signature,
    confirmationSignature: input.signature,
    strategyId: input.strategyId,
    openIntentId: input.positionState.openIntentId,
    positionId: input.positionState.positionId,
    chainPositionAddress: input.positionState.chainPositionAddress,
    mint: input.positionState.activeMint,
    tokenMint: input.positionState.activeMint,
    symbol: '',
    tokenSymbol: '',
    side: 'add-lp',
    amount: input.entrySol,
    filledSol: input.entrySol,
    actualFilledSol: input.entrySol,
    actualWalletDeltaSol: -input.entrySol,
    fillAmountSource: 'chain-reconstructed',
    hasFillEvidence: true,
    status: 'confirmed',
    confirmationStatus: 'confirmed',
    recordedAt: input.openedAt
  };
  const journal = new LiveFillJournal(join(input.journalRootDir, `${input.strategyId}-live-fills.jsonl`), {
    rotateDaily: true,
    retentionDays: 90,
    now: () => new Date(input.openedAt)
  });

  await journal.append(fillEntry);

  input.mirrorRuntime?.enqueue(toFillMirrorEvent({
    lifecycleKey,
    fillId,
    submissionId: input.signature,
    confirmationSignature: input.signature,
    cycleId: input.cycleId,
    openIntentId: input.positionState.openIntentId,
    positionId: input.positionState.positionId,
    chainPositionAddress: input.positionState.chainPositionAddress,
    tokenMint: input.positionState.activeMint ?? '',
    tokenSymbol: '',
    side: 'add-lp',
    amount: input.entrySol,
    filledSol: input.entrySol,
    actualFilledSol: input.entrySol,
    actualWalletDeltaSol: -input.entrySol,
    fillAmountSource: 'chain-reconstructed',
    hasFillEvidence: true,
    recordedAt: input.openedAt
  }));
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
    if (hasActionableTokenAmount(token) && isNonStableMint(token.mint)) {
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

async function suppressCooldownResidualWalletTokens(input: {
  accountState?: LiveAccountState;
  residualTokenSweepStore: ResidualTokenSweepStore;
  residualTokenSweepMinValueSol: number;
  suppressAllEligibleResidualTokens: boolean;
  nowIso: string;
}) {
  if (!input.accountState?.walletTokens?.length && !input.accountState?.journalTokens?.length) {
    return {
      accountState: input.accountState,
      suppressedMints: [] as string[]
    };
  }

  const suppressedMints: string[] = [];
  type WalletToken = NonNullable<LiveAccountState['walletTokens']>[number];
  const shouldSuppressToken = async (token: WalletToken) => {
    const nonStableResidualToken = isNonStableMint(token.mint) && hasActionableTokenAmount(token);
    if (!nonStableResidualToken) {
      return false;
    }

    const hasValuation = typeof token.currentValueSol === 'number' && Number.isFinite(token.currentValueSol);
    const eligibleResidualToken = hasValuation && token.currentValueSol! >= input.residualTokenSweepMinValueSol;
    const uneconomicResidualToken = hasValuation && token.currentValueSol! < input.residualTokenSweepMinValueSol;
    const cooldown = await input.residualTokenSweepStore.readActive(token.mint, input.nowIso);

    if (cooldown) {
      if (eligibleResidualToken) {
        suppressedMints.push(token.mint);
      }
      return true;
    }

    if (uneconomicResidualToken) {
      // Dust tokens below the sweep threshold are silently filtered from
      // accountState but MUST NOT land in suppressedMints, otherwise the
      // daemon would continuously set a blocking residual-sweep-cooldown
      // reason that prevents both LP exits and new-opens.
      return true;
    }

    if (eligibleResidualToken && input.suppressAllEligibleResidualTokens) {
      suppressedMints.push(token.mint);
      return true;
    }

    return false;
  };

  const filterTokens = async (tokens: WalletToken[]) => {
    const filteredTokens = [];
    for (const token of tokens) {
      if (await shouldSuppressToken(token)) {
        continue;
      }
      filteredTokens.push(token);
    }
    return filteredTokens;
  };

  const walletTokens = await filterTokens(input.accountState?.walletTokens ?? []);
  const journalTokens = await filterTokens(input.accountState?.journalTokens ?? []);

  const tokensUnchanged = walletTokens.length === (input.accountState?.walletTokens ?? []).length
    && journalTokens.length === (input.accountState?.journalTokens ?? []).length;

  if (tokensUnchanged) {
    return {
      accountState: input.accountState,
      suppressedMints
    };
  }

  return {
    accountState: {
      ...input.accountState,
      walletTokens,
      journalTokens
    },
    suppressedMints
  };
}

async function recordResidualCooldownForSellAttempt(input: {
  result: Awaited<ReturnType<typeof runLiveCycle>>;
  residualTokenSweepStore: ResidualTokenSweepStore;
  residualTokenSweepCooldownMs: number;
  now: Date;
}) {
  if (input.result.action !== 'dca-out') {
    return;
  }

  const attemptedResidualCleanup = input.result.liveOrderSubmitted
    || input.result.failureSource === 'quote'
    || input.result.failureSource === 'signer'
    || input.result.failureSource === 'broadcast';
  if (!attemptedResidualCleanup) {
    return;
  }

  const mint = typeof input.result.context.token.mint === 'string'
    ? input.result.context.token.mint
    : '';
  if (!isNonStableMint(mint)) {
    return;
  }

  const nowIsoValue = input.now.toISOString();
  await input.residualTokenSweepStore.upsert({
    mint,
    lastAttemptAt: nowIsoValue,
    cooldownUntil: new Date(input.now.getTime() + input.residualTokenSweepCooldownMs).toISOString(),
    updatedAt: nowIsoValue
  });
}

async function recordTargetOpenCooldownForResult(input: {
  result: Awaited<ReturnType<typeof runLiveCycle>>;
  targetOpenCooldownStore: TargetOpenCooldownStore;
}) {
  if (!isOpenPathTargetCooldownFailure({
    action: input.result.action,
    failureSource: input.result.failureSource,
    reason: input.result.reason
  })) {
    return;
  }

  const cooldownNow = nowIso();
  const broadcastTargetCooldownMs = input.result.broadcastResult?.status === 'failed'
    ? input.result.broadcastResult.targetCooldownMs
    : undefined;
  const cooldownMs = typeof broadcastTargetCooldownMs === 'number' && Number.isFinite(broadcastTargetCooldownMs)
    ? Math.max(0, broadcastTargetCooldownMs)
    : 5 * 60_000;
  await input.targetOpenCooldownStore.upsert({
    poolAddress: typeof input.result.context.pool.address === 'string' ? input.result.context.pool.address : '',
    tokenMint: typeof input.result.context.token.mint === 'string' ? input.result.context.token.mint : '',
    reason: input.result.reason,
    cooldownUntil: new Date(Date.now() + cooldownMs).toISOString(),
    lastFailedAt: cooldownNow,
    updatedAt: cooldownNow
  });
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
  const walletToken = (input.accountState?.walletTokens ?? []).find((token) =>
    token.mint === input.trackedToken.tokenMint && hasActionableTokenAmount(token)
  );
  const journalToken = (input.accountState?.journalTokens ?? []).find((token) =>
    token.mint === input.trackedToken.tokenMint && hasActionableTokenAmount(token)
  );
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

function collectActiveExposureMints(input: {
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot;
}) {
  const mints = new Set<string>();

  if (input.positionState?.activeMint && input.positionState.lifecycleState !== 'closed') {
    mints.add(input.positionState.activeMint);
  }

  for (const token of [
    ...(input.accountState?.walletTokens ?? []),
    ...(input.accountState?.journalTokens ?? [])
  ]) {
    if (isNonStableMint(token.mint) && hasActionableTokenAmount(token)) {
      mints.add(token.mint);
    }
  }

  for (const position of [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ]) {
    if (isNonStableMint(position.mint) && (position.hasLiquidity ?? true)) {
      mints.add(position.mint);
    }
  }

  return [...mints];
}

function countActiveLpExposures(accountState?: LiveAccountState) {
  const keys = new Set<string>();
  for (const position of collectActiveLpPositions(accountState)) {
    keys.add(position.chainPositionAddress || position.positionAddress || position.positionId || `${position.poolAddress}:${position.mint}`);
  }
  return keys.size;
}

function collectClosedLedgerChainKeys(ledger?: PositionLedgerSnapshot | null) {
  const keys = new Set<string>();

  for (const record of ledger?.records ?? []) {
    if (record.lifecycleState !== 'closed') {
      continue;
    }

    const key = record.chainPositionAddress
      || record.positionId
      || (record.positionKey.startsWith('chain-position:')
        ? record.positionKey.slice('chain-position:'.length)
        : '');
    if (key) {
      keys.add(key);
    }
  }

  return keys;
}

function suppressClosedLedgerLpPositions(input: {
  accountState?: LiveAccountState;
  ledger?: PositionLedgerSnapshot | null;
}): LiveAccountState | undefined {
  if (!input.accountState) {
    return undefined;
  }

  const closedChainKeys = collectClosedLedgerChainKeys(input.ledger);
  if (closedChainKeys.size === 0) {
    return input.accountState;
  }

  const keepPosition = (position: NonNullable<LiveAccountState['walletLpPositions']>[number]) => {
    const key = position.chainPositionAddress || position.positionAddress || position.positionId;
    return !key || !closedChainKeys.has(key);
  };
  const walletLpPositions = (input.accountState.walletLpPositions ?? []).filter(keepPosition);
  const journalLpPositions = (input.accountState.journalLpPositions ?? []).filter(keepPosition);

  if (
    walletLpPositions.length === (input.accountState.walletLpPositions ?? []).length &&
    journalLpPositions.length === (input.accountState.journalLpPositions ?? []).length
  ) {
    return input.accountState;
  }

  return {
    ...input.accountState,
    walletLpPositions,
    journalLpPositions
  };
}

// B2: collect active LP positions that are NOT tracked in positionState.
// Used at startup to discover orphan positions that need reconciliation.
function collectUntrackedActiveLps(input: {
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot | null;
}): NonNullable<LiveAccountState['walletLpPositions']>[number][] {
  if (!input.accountState) {
    return [];
  }
  const positions = [
    ...(input.accountState.walletLpPositions ?? []),
    ...(input.accountState.journalLpPositions ?? [])
  ].filter((position) => isNonStableMint(position.mint) && (position.hasLiquidity ?? true));

  if (!input.positionState?.activeMint) {
    return positions;
  }
  const positionState = input.positionState;

  return positions.filter((position) => {
    if (positionState.chainPositionAddress) {
      return position.positionAddress !== positionState.chainPositionAddress
        && position.chainPositionAddress !== positionState.chainPositionAddress;
    }
    return position.mint !== positionState.activeMint;
  });
}

function hasNonStableTokenInventory(input: {
  accountState?: LiveAccountState;
  minValueSol: number;
}) {
  return [
    ...(input.accountState?.walletTokens ?? []),
    ...(input.accountState?.journalTokens ?? [])
  ].some((token) =>
    isNonStableMint(token.mint) &&
    hasActionableTokenAmount(token) &&
    (
      typeof token.currentValueSol !== 'number' ||
      token.currentValueSol >= input.minValueSol
    )
  );
}

function buildNewOpenExecutionAccountState(accountState?: LiveAccountState): LiveAccountState | undefined {
  if (!accountState) {
    return undefined;
  }

  return {
    ...accountState,
    walletTokens: [],
    journalTokens: [],
    walletLpPositions: [],
    journalLpPositions: []
  };
}

function hasReadyCompleteActiveLpValuation(input: {
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot;
}) {
  const positions = [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ].filter((position) => isNonStableMint(position.mint) && (position.hasLiquidity ?? true));

  if (positions.length === 0) {
    return false;
  }

  const active = input.positionState?.chainPositionAddress
    ? positions.find((position) =>
        position.positionAddress === input.positionState?.chainPositionAddress ||
        position.chainPositionAddress === input.positionState?.chainPositionAddress
      )
    : input.positionState?.activePoolAddress
      ? positions.find((position) => position.poolAddress === input.positionState?.activePoolAddress)
      : input.positionState?.activeMint
        ? positions.find((position) => position.mint === input.positionState?.activeMint)
        : positions[0];

  return active?.valuationStatus === 'ready'
    && active?.valuationCompleteness === 'complete'
    && active?.valuationTrust === 'exit_quote';
}

function shouldUseNewOpenPassResult(result: LiveCycleResult) {
  return result.action === 'add-lp' && result.liveOrderSubmitted;
}

export function resolveNewOpenPassSkipReason(input: {
  enabled: boolean;
  maintenanceResult: LiveCycleResult;
  runtimeMode: RuntimeMode;
  pendingSubmission: boolean;
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot;
  businessSemantics: PositionBusinessSemantics;
  maxActivePositions: number;
  residualTokenSweepMinValueSol: number;
}) {
  if (!input.enabled) {
    return 'disabled';
  }

  if (input.pendingSubmission) {
    return 'pending-submission';
  }

  if (input.runtimeMode !== 'healthy' && input.runtimeMode !== 'degraded') {
    return `runtime-mode:${input.runtimeMode}`;
  }

  return input.businessSemantics.canRunNewOpenAfterMaintenance.allowed
    ? undefined
    : input.businessSemantics.canRunNewOpenAfterMaintenance.reason;
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
  return normalized === 'fetch failed'
    || normalized === 'timeout'
    || normalized === 'rate-limited'
    || normalized === 'http-400'
    || /^http-5\d\d$/.test(normalized);
}

function isLegacyFetchFailureCircuitReason(reason: string) {
  return reason.trim().toLowerCase() === 'fetch failed';
}

function isTransientAutoHealableError(error: unknown) {
  if (error instanceof ExecutionRequestError) {
    return error.operation === 'account' && isTransientAutoHealableCircuitReason(error.reason);
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

  if (isLegacyFetchFailureCircuitReason(input.runtimeState.circuitReason)) {
    return true;
  }

  return isTransientAutoHealableCircuitReason(input.runtimeState.circuitReason)
    && isTransientAutoHealableCircuitReason(input.dependencyHealth.account.lastFailureReason)
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
  preparedBroadcastStore: PreparedBroadcastStore;
  spendingLimitsStore?: SpendingLimitsStore;
  broadcaster?: Omit<LiveCycleInput, 'strategy'>['broadcaster'];
  accountProvider?: LiveAccountStateProvider;
  confirmationProvider?: LiveConfirmationProvider;
}) {
  const preparedRecovery = await recoverPreparedBroadcast({
    preparedBroadcastStore: input.preparedBroadcastStore,
    pendingSubmissionStore: input.pendingSubmissionStore,
    broadcaster: input.broadcaster,
    spendingLimitsStore: input.spendingLimitsStore
  });
  const pendingSubmission = preparedRecovery.pendingSubmission;

  if (preparedRecovery.blocked) {
    const effectiveAccountState = pendingSubmission && input.accountProvider
      ? await input.accountProvider.readState()
      : undefined;
    if (pendingSubmission) {
      const recovery = await recoverPendingSubmission({
        pendingSubmission,
        confirmationProvider: input.confirmationProvider,
        accountState: effectiveAccountState
      });

      if (recovery.clearPending) {
        if (recovery.reason === 'pending-submission-failed') {
          // Persist the pre-submit disposition before removing the WAL. This
          // path is only reachable for a timed-out paper/shadow reduce-risk
          // request whose exact overlay position is still present.
          await input.preparedBroadcastStore.markNotSubmitted(
            'paper-pending-submission-not-executed'
          );
        }
        await input.preparedBroadcastStore.clear();
        return {
          pendingSubmission: null,
          resolvedPendingSubmission: pendingSubmission,
          effectiveAccountState,
          recoveryReason: recovery.reason
        };
      }

      if (recovery.nextPendingSubmission) {
        await input.pendingSubmissionStore.write(recovery.nextPendingSubmission);
        return {
          pendingSubmission: recovery.nextPendingSubmission,
          resolvedPendingSubmission: null,
          effectiveAccountState,
          recoveryReason: recovery.reason
        };
      }
    }

    return {
      pendingSubmission,
      resolvedPendingSubmission: null,
      effectiveAccountState,
      recoveryReason: 'pending-submission-recovery-required' as const
    };
  }

  if (!pendingSubmission) {
    return {
      pendingSubmission: null,
      resolvedPendingSubmission: null,
      effectiveAccountState: undefined as LiveAccountState | undefined,
      recoveryReason: 'clear' as const
    };
  }

  const effectiveAccountState = input.accountProvider
    ? await input.accountProvider.readState()
    : undefined;

  const recovery = await recoverPendingSubmission({
    pendingSubmission,
    confirmationProvider: input.confirmationProvider,
    accountState: effectiveAccountState
  });

  if (recovery.clearPending) {
    // Keep the durable identity until the caller has persisted the recovered
    // position/ownership state. A crash between confirmation and that state
    // write must replay recovery, not erase the only binding evidence.
    return {
      pendingSubmission: null,
      resolvedPendingSubmission: pendingSubmission,
      effectiveAccountState,
      recoveryReason: recovery.reason
    };
  }

  if (recovery.nextPendingSubmission) {
    await input.pendingSubmissionStore.write(recovery.nextPendingSubmission);
    return {
      pendingSubmission: recovery.nextPendingSubmission,
      resolvedPendingSubmission: null,
      effectiveAccountState,
      recoveryReason: recovery.reason
    };
  }

  return {
    pendingSubmission,
    resolvedPendingSubmission: null,
    effectiveAccountState,
    recoveryReason: recovery.reason
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeJournalFillEntry(entry: JournalFillEntry): RuntimeFillEntry | null {
  const mint = typeof entry.mint === 'string'
    ? entry.mint
    : typeof entry.tokenMint === 'string'
      ? entry.tokenMint
      : '';
  const side = entry.side;
  const amount = typeof entry.actualFilledSol === 'number' && entry.actualFilledSol > 0
    ? entry.actualFilledSol
    : typeof entry.filledSol === 'number' && entry.filledSol > 0
      ? entry.filledSol
      : typeof entry.amount === 'number'
        ? entry.amount
        : undefined;
  const recordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt : '';

  if (
    !mint
    || side !== 'add-lp'
    || typeof amount !== 'number'
    || amount <= 0
    || !recordedAt
    || entry.hasFillEvidence !== true
    || !isTrustedFillAmountSource(entry.fillAmountSource)
  ) {
    return null;
  }

  return {
    submissionId: typeof entry.submissionId === 'string' ? entry.submissionId : undefined,
    openIntentId: typeof entry.openIntentId === 'string' ? entry.openIntentId : undefined,
    positionId: typeof entry.positionId === 'string' ? entry.positionId : undefined,
    chainPositionAddress: typeof entry.chainPositionAddress === 'string' ? entry.chainPositionAddress : undefined,
    mint,
    side,
    amount,
    actualFilledSol: typeof entry.actualFilledSol === 'number' ? entry.actualFilledSol : undefined,
    fillAmountSource: entry.fillAmountSource,
    hasFillEvidence: entry.hasFillEvidence,
    recordedAt
  };
}

async function readTrustedAddLpFills(input: {
  strategy: StrategyId;
  journalRootDir: string;
}) {
  const rows = await readRotatedJsonLines<JournalFillEntry>(
    join(input.journalRootDir, `${input.strategy}-live-fills.jsonl`)
  );

  return rows.flatMap((row) => {
    const normalized = normalizeJournalFillEntry(row);
    return normalized ? [normalized] : [];
  });
}

function resolveConfirmedOpenFillEntry(input: {
  resultFill?: LiveCycleConfirmedFill;
  activeMint?: string;
}): TrustedLpEntryMetadata | undefined {
  const resultFill = input.resultFill;
  if (
    (resultFill?.side !== 'add-lp' && resultFill?.side !== 'deploy')
    || resultFill.fillAmountSource !== 'wallet-delta'
    || resultFill.hasFillEvidence !== true
    || resultFill.filledSol <= 0
    || (input.activeMint && resultFill.mint !== input.activeMint)
  ) {
    return undefined;
  }

  return {
    entrySol: resultFill.filledSol,
    entrySolSource: 'actual_fill',
    entryFillSubmissionId: resultFill.submissionId,
    openedAt: resultFill.recordedAt
  };
}

function trustedEntryChanged(current: PositionStateSnapshot | undefined, next: TrustedLpEntryMetadata | undefined) {
  if (!next) {
    return false;
  }

  return current?.entrySol !== next.entrySol
    || current?.entrySolSource !== next.entrySolSource
    || current?.entryFillSubmissionId !== next.entryFillSubmissionId
    || (!current?.openedAt && Boolean(next.openedAt));
}

function positionStateTargetMatches(input: {
  positionState?: PositionStateSnapshot | null;
  activeMint?: string;
  activePoolAddress?: string;
}) {
  return Boolean(
    input.positionState?.activeMint &&
    input.positionState?.activePoolAddress &&
    input.activeMint &&
    input.activePoolAddress &&
    input.positionState.activeMint === input.activeMint &&
    input.positionState.activePoolAddress === input.activePoolAddress
  );
}

function resolveTrustedEntryEvidenceProblem(input: {
  positionState: PositionStateSnapshot;
  fills: RuntimeFillEntry[];
}): 'missing' | 'mismatch' | undefined {
  if (
    !input.positionState.entryFillSubmissionId ||
    !input.positionState.activeMint ||
    !isTrustedEntrySolSource(input.positionState.entrySolSource)
  ) {
    return undefined;
  }

  if (input.positionState.entrySolSource !== 'actual_fill') {
    return undefined;
  }

  const matchedFill = input.fills.find((fill) =>
    fill.submissionId === input.positionState.entryFillSubmissionId
    && (fill.side === 'add-lp' || fill.side === 'buy')
    && fill.hasFillEvidence === true
    && isTrustedFillAmountSource(fill.fillAmountSource)
  );

  if (!matchedFill) {
    return 'missing';
  }

  return matchedFill.mint === input.positionState.activeMint ? undefined : 'mismatch';
}

type ResidualSweepExecutionResult = {
  dependencyHealth: ReturnType<typeof createDependencyHealthSnapshot>;
  nextSweepAt: string;
  resolvedMints: string[];
};

function strategyOwnedResidualAmountByMint(ledger?: PositionLedgerSnapshot) {
  const amounts = new Map<string, bigint>();
  for (const record of ledger?.records ?? []) {
    if (
      record.residualCleanupStatus !== 'residual_cleanup_pending'
      || !record.activeMint
      || !record.residualCleanupAmountRaw
      || !/^\d+$/.test(record.residualCleanupAmountRaw)
    ) {
      continue;
    }
    amounts.set(
      record.activeMint,
      (amounts.get(record.activeMint) ?? 0n) + BigInt(record.residualCleanupAmountRaw)
    );
  }
  return amounts;
}

function markResidualCleanupResolved(
  ledger: PositionLedgerSnapshot | undefined,
  resolvedMints: string[],
  now: string
) {
  if (!ledger || resolvedMints.length === 0) {
    return ledger;
  }
  const resolved = new Set(resolvedMints);
  return {
    ...ledger,
    records: ledger.records.map((record) => resolved.has(record.activeMint ?? '')
      && record.residualCleanupStatus === 'residual_cleanup_pending'
      ? {
          ...record,
          residualCleanupStatus: 'residual_cleanup_complete',
          residualCleanupAmountRaw: undefined,
          updatedAt: now
        }
      : record),
    updatedAt: now
  };
}

async function runResidualTokenSweepIfDue(input: {
  strategy: StrategyId;
  executionPolicy: 'broadcast' | 'simulate-only';
  captureMode?: NonNullable<LiveCycleInput['captureMode']>;
  maxSlippageBps: number;
  maxImpactBps: number;
  accountState?: LiveAccountState;
  positionLedger?: PositionLedgerSnapshot;
  runtimeMode: RuntimeMode;
  runtimeReason?: string;
  pendingSubmission: boolean;
  signer?: Omit<LiveCycleInput, 'strategy'>['signer'];
  broadcaster?: Omit<LiveCycleInput, 'strategy'>['broadcaster'];
  confirmationProvider?: LiveConfirmationProvider;
  dependencyHealth: ReturnType<typeof createDependencyHealthSnapshot>;
  residualTokenSweepStore: ResidualTokenSweepStore;
  residualTokenSweepIntervalMs: number;
  residualTokenSweepCooldownMs: number;
  residualTokenSweepMinValueSol: number;
  nextSweepAt: string;
  preparedBroadcastStore: PreparedBroadcastStore;
  pendingSubmissionStore: PendingSubmissionStore;
}) : Promise<ResidualSweepExecutionResult> {
  const now = new Date();
  const nowIsoValue = now.toISOString();
  let dependencyHealth = input.dependencyHealth;

  if (input.nextSweepAt && input.nextSweepAt > nowIsoValue) {
    return { dependencyHealth, nextSweepAt: input.nextSweepAt, resolvedMints: [] };
  }

  const nextSweepAt = new Date(now.getTime() + input.residualTokenSweepIntervalMs).toISOString();
  const runtimeAllowsMaintenance =
    input.runtimeMode === 'healthy'
    || input.runtimeMode === 'degraded'
    || input.runtimeMode === 'flatten_only'
    || (input.runtimeMode === 'recovering' && input.runtimeReason === 'reconcile-degraded')
    || (input.runtimeMode === 'recovering' && isTransientAutoHealableCircuitReason(input.runtimeReason ?? ''))
    || (input.runtimeMode === 'circuit_open' && isTransientAutoHealableCircuitReason(input.runtimeReason ?? ''));

  if (
    !runtimeAllowsMaintenance
    || input.pendingSubmission
    || !input.signer
    || !input.broadcaster
  ) {
    return { dependencyHealth, nextSweepAt, resolvedMints: [] };
  }

  await input.residualTokenSweepStore.pruneExpired(nowIsoValue);
  const ownedAmountByMint = strategyOwnedResidualAmountByMint(input.positionLedger);
  const eligibleTokens = (input.accountState?.walletTokens ?? [])
    .filter((token) =>
      ownedAmountByMint.has(token.mint)
      &&
      hasActionableTokenAmount(token)
      && isNonStableMint(token.mint)
      && typeof token.currentValueSol === 'number'
      && token.currentValueSol >= input.residualTokenSweepMinValueSol
    )
    .sort((left, right) => (right.currentValueSol ?? 0) - (left.currentValueSol ?? 0));

  for (const token of eligibleTokens) {
    const activeCooldown = await input.residualTokenSweepStore.readActive(token.mint, nowIsoValue);
    if (activeCooldown) {
      continue;
    }

    const preExitTokenAmountRaw = sumWalletTokenRaw(input.accountState, token.mint)?.toString();
    if (preExitTokenAmountRaw === undefined) {
      // Exact raw ownership is required so a restart can prove that only the
      // ledger-owned residual was disposed. Never submit a maintenance sell
      // that could later be confused with same-mint personal inventory.
      continue;
    }

    const orderIntent = buildOrderIntent({
      strategyId: input.strategy,
      // Residual inventory is wallet-owned rather than pool-bound. Keeping
      // this empty makes the exact-in sell use the normal route chain and also
      // lets paper match the synthetic inventory by mint.
      poolAddress: '',
      outputSol: token.currentValueSol ?? 0,
      executionPolicy: input.executionPolicy,
      side: 'sell',
      tokenMint: token.mint,
      fullPositionExit: true,
      maxSlippageBps: input.maxSlippageBps,
      maxImpactBps: input.maxImpactBps,
      inputAmountRaw: ownedAmountByMint.get(token.mint)?.toString(),
      preExitTokenAmountRaw
    });

    let attemptRecorded = false;
    const recordAttempt = async () => {
      if (attemptRecorded) {
        return;
      }

      attemptRecorded = true;
      await input.residualTokenSweepStore.upsert({
        mint: token.mint,
        lastAttemptAt: nowIsoValue,
        cooldownUntil: new Date(now.getTime() + input.residualTokenSweepCooldownMs).toISOString(),
        updatedAt: nowIsoValue
      });
    };

    try {
      const signedIntent = await input.signer.sign(orderIntent);
      dependencyHealth = markDependencySuccess(dependencyHealth, 'signer', nowIso());
      await input.preparedBroadcastStore.write(buildPreparedBroadcastSnapshot({
        strategyId: input.strategy,
        signedIntent,
        action: 'dca-out',
        captureMode: input.captureMode,
        poolAddress: orderIntent.poolAddress,
        tokenMint: token.mint,
        tokenSymbol: token.symbol ?? token.mint,
        requestedPositionSol: token.currentValueSol ?? 0,
        createdAt: orderIntent.createdAt
      }));
      const preparedRecovery = await recoverPreparedBroadcast({
        preparedBroadcastStore: input.preparedBroadcastStore,
        pendingSubmissionStore: input.pendingSubmissionStore,
        broadcaster: input.broadcaster
      });

      await recordAttempt();

      if (preparedRecovery.status !== 'submitted' || preparedRecovery.broadcastResult?.status !== 'submitted') {
        dependencyHealth = markDependencyFailure(
          dependencyHealth,
          'broadcaster',
          preparedRecovery.reason,
          nowIso()
        );
        return { dependencyHealth, nextSweepAt, resolvedMints: [] };
      }

      const broadcastResult = preparedRecovery.broadcastResult;

      dependencyHealth = markDependencySuccess(dependencyHealth, 'broadcaster', nowIso());

      if (broadcastResult.mainExecutionStatus === 'confirmed' && broadcastResult.batchStatus !== 'partial') {
        // Keep the durable pending identity. The next pre-ingest recovery uses
        // a fresh complete account snapshot to prove the exact raw token
        // decrease, persists residual completion, and only then clears it.
        return { dependencyHealth, nextSweepAt, resolvedMints: [] };
      }

      if (input.confirmationProvider && broadcastResult.submissionId) {
        const confirmation = await input.confirmationProvider.poll({
          submissionId: broadcastResult.submissionId,
          confirmationSignature: broadcastResult.confirmationSignature
        });

        if (
          confirmation.status === 'confirmed'
          && (confirmation.finality === 'confirmed' || confirmation.finality === 'finalized')
        ) {
          dependencyHealth = markDependencySuccess(dependencyHealth, 'confirmation', nowIso());
          const pending = await input.pendingSubmissionStore.read();
          if (pending?.idempotencyKey === orderIntent.idempotencyKey) {
            await input.pendingSubmissionStore.write({
              ...pending,
              confirmationStatus: 'confirmed',
              finality: confirmation.finality,
              lastCheckedAt: confirmation.checkedAt,
              updatedAt: confirmation.checkedAt,
              reason: confirmation.reason ?? pending.reason
            });
          }
          return { dependencyHealth, nextSweepAt, resolvedMints: [] };
        } else if (confirmation.status === 'failed') {
          dependencyHealth = markDependencyFailure(
            dependencyHealth,
            'confirmation',
            confirmation.reason ?? 'maintenance-confirmation-failed',
            nowIso()
          );
          const pending = await input.pendingSubmissionStore.read();
          if (pending?.idempotencyKey === orderIntent.idempotencyKey) {
            await input.pendingSubmissionStore.write({
              ...pending,
              confirmationStatus: 'failed',
              finality: 'failed',
              lastCheckedAt: confirmation.checkedAt,
              updatedAt: confirmation.checkedAt,
              reason: confirmation.reason ?? 'maintenance-confirmation-failed'
            });
          }
        }
      }

      return { dependencyHealth, nextSweepAt, resolvedMints: [] };
    } catch (error) {
      await recordAttempt();

      if (error instanceof ExecutionRequestError) {
        const dependencyKey = error.operation === 'broadcast'
          ? 'broadcaster'
          : error.operation === 'confirmation'
            ? 'confirmation'
            : error.operation === 'account'
              ? 'account'
              : error.operation === 'quote'
                ? 'quote'
                : 'signer';
        dependencyHealth = markDependencyFailure(
          dependencyHealth,
          dependencyKey,
          error.reason,
          nowIso()
        );
        return { dependencyHealth, nextSweepAt, resolvedMints: [] };
      }

      throw error;
    }
  }

  return { dependencyHealth, nextSweepAt, resolvedMints: [] };
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
  const hotBinFromContext = typeof lpSolDepletedBins === 'number' && lpSolDepletedBins >= DEFAULT_SOL_DEPLETION_EXIT_BINS;
  const hotBinFromAccount = accountLpPositions.some((position) =>
    isManageableLpPosition(position) &&
    typeof position.solDepletedBins === 'number' &&
    position.solDepletedBins >= DEFAULT_SOL_DEPLETION_EXIT_BINS
  );
  const hotRangeFromAccount = accountLpPositions.some((position) =>
    isManageableLpPosition(position) &&
    typeof position.activeBinId === 'number' &&
    typeof position.lowerBinId === 'number' &&
    typeof position.upperBinId === 'number' &&
    (
      position.activeBinId < position.lowerBinId ||
      position.activeBinId > position.upperBinId ||
      Math.min(position.activeBinId - position.lowerBinId, position.upperBinId - position.activeBinId) <= 3
    )
  );

  return hotPnl || hotBinFromContext || hotBinFromAccount || hotRangeFromAccount;
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

export function isOpenPathTargetCooldownFailure(input: {
  action?: string;
  failureSource?: string;
  reason?: string;
}) {
  if (input.failureSource !== 'broadcast') {
    return false;
  }

  if (input.action !== 'deploy' && input.action !== 'add-lp') {
    return false;
  }

  const reason = input.reason ?? '';
  return input.reason === 'fetch failed' ||
    input.reason === 'rate-limited' ||
    /429|rate-limit/i.test(reason) ||
    (/transaction simulation failed/i.test(reason) && /custom program error/i.test(reason));
}

function isBadExitReopenCooldownReason(reason: string) {
  return reason.includes('lp-stop-loss') ||
    reason.includes('lp-sol-nearly-depleted') ||
    reason.includes('lp-out-of-range') ||
    reason.includes('solDepletedBins=') ||
    reason.includes('sol-depleted');
}

function resolveExitReopenCooldownMs(input: {
  action: string;
  liveOrderSubmitted: boolean;
  resultReason: string;
  auditReason: string;
}) {
  if (input.action !== 'withdraw-lp') {
    return 0;
  }

  const combinedReason = `${input.resultReason} ${input.auditReason}`;
  if (isBadExitReopenCooldownReason(combinedReason)) {
    return BAD_EXIT_REOPEN_COOLDOWN_MS;
  }

  if (
    input.liveOrderSubmitted ||
    input.resultReason.includes('position-already-closed') ||
    input.auditReason.includes('lp-take-profit')
  ) {
    return RECENT_CLOSE_RECONCILE_COOLDOWN_MS;
  }

  return 0;
}

async function readActiveTargetOpenCooldowns(input: {
  store: TargetOpenCooldownStore;
  now: string;
}) {
  const rows = await input.store.readAll();
  return rows.filter((row) => row.cooldownUntil > input.now);
}

async function recordExitTargetOpenCooldown(input: {
  store: TargetOpenCooldownStore;
  poolAddress: string;
  tokenMint: string;
  result: LiveCycleResult;
  now: string;
}) {
  if (!input.poolAddress || !input.tokenMint) {
    return;
  }

  const cooldownMs = resolveExitReopenCooldownMs({
    action: input.result.action,
    liveOrderSubmitted: input.result.liveOrderSubmitted,
    resultReason: input.result.reason,
    auditReason: input.result.audit.reason
  });
  if (cooldownMs <= 0) {
    return;
  }

  await input.store.upsert({
    poolAddress: input.poolAddress,
    tokenMint: input.tokenMint,
    reason: input.result.audit.reason || input.result.reason,
    cooldownUntil: new Date(Date.parse(input.now) + cooldownMs).toISOString(),
    lastFailedAt: input.now,
    updatedAt: input.now
  });
}

async function warmAccountProvider(accountProvider?: LiveAccountStateProvider) {
  if (!accountProvider) {
    return undefined;
  }

  try {
    return await accountProvider.readState();
  } catch {
    // Best-effort warmup only; normal tick handling still owns real failures.
    return undefined;
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

function hasMatchingLpPosition(input: {
  accountState?: LiveAccountState;
  chainPositionAddress?: string;
  activeMint?: string;
  activePoolAddress?: string;
}) {
  const positions = [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ];

  return positions.some((position) => {
    if (!isManageableLpPosition(position)) {
      return false;
    }

    if (input.chainPositionAddress) {
      return position.positionAddress === input.chainPositionAddress
        || position.chainPositionAddress === input.chainPositionAddress;
    }

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

function hasOpenInventory(accountState?: LiveAccountState) {
  return Boolean(
    accountState?.walletTokens?.some((token) => hasActionableTokenAmount(token)
      && token.mint !== 'So11111111111111111111111111111111111111112'
      && token.mint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') ||
    accountState?.walletLpPositions?.some((position) =>
      isManageableLpPosition(position)
      &&
      position.mint !== 'So11111111111111111111111111111111111111112'
      && position.mint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  );
}

function sumWalletTokenRaw(accountState: LiveAccountState | undefined, mint?: string) {
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

function recoveredOpenWalletDeltaIsPlausible(
  pending: PendingSubmissionSnapshot,
  actualFilledSol: number
) {
  const requestedPositionSol = pending.requestedPositionSol;
  if (
    typeof requestedPositionSol !== 'number'
    || !Number.isFinite(requestedPositionSol)
    || requestedPositionSol <= 0
  ) {
    return false;
  }

  // Wallet deltas include network fees and, for LP opens, account rent. Keep
  // a conservative bounded allowance without accepting arbitrary unrelated
  // wallet activity accumulated while the daemon was down.
  const feeAndRentBufferSol = Math.max(0.01, requestedPositionSol * 0.2);
  return actualFilledSol <= requestedPositionSol + feeAndRentBufferSol;
}

function resolveRecoveredSpotOpenEvidence(input: {
  pendingSubmission?: PendingSubmissionSnapshot | null;
  accountState?: LiveAccountState;
  recordedAt: string;
}): {
  fill?: LiveCycleConfirmedFill;
  failureReason?: string;
} {
  const pending = input.pendingSubmission;
  if (
    pending?.orderAction !== 'deploy'
    || !pending.tokenMint
    || !pending.submissionId
    || pending.preEntryTokenAmountRaw === undefined
    || typeof pending.preEntryWalletSol !== 'number'
  ) {
    return {
      failureReason: 'spot-ownership-reconcile-required:recovered-open-baseline-missing'
    };
  }
  const currentRaw = sumWalletTokenRaw(input.accountState, pending.tokenMint);
  if (currentRaw === undefined || currentRaw <= BigInt(pending.preEntryTokenAmountRaw)) {
    return {
      failureReason: currentRaw === undefined
        ? 'spot-ownership-reconcile-required:recovered-open-token-raw-unavailable'
        : 'spot-ownership-reconcile-required:recovered-open-token-delta-missing'
    };
  }
  const actualFilledSol = pending.preEntryWalletSol - (input.accountState?.walletSol ?? pending.preEntryWalletSol);
  if (!Number.isFinite(actualFilledSol) || actualFilledSol <= 0) {
    return {
      failureReason: 'spot-ownership-reconcile-required:recovered-open-wallet-delta-missing'
    };
  }
  if (!recoveredOpenWalletDeltaIsPlausible(pending, actualFilledSol)) {
    return {
      failureReason: 'spot-ownership-reconcile-required:recovered-open-wallet-delta-out-of-bounds'
    };
  }
  return {
    fill: {
      submissionId: pending.submissionId,
      mint: pending.tokenMint,
      side: 'deploy',
      filledSol: actualFilledSol,
      actualFilledSol,
      actualWalletDeltaSol: -actualFilledSol,
      acquiredTokenAmountRaw: (currentRaw - BigInt(pending.preEntryTokenAmountRaw)).toString(),
      fillAmountSource: 'wallet-delta',
      recordedAt: input.recordedAt,
      hasFillEvidence: true
    }
  };
}

function resolveRecoveredLpResidualEvidence(input: {
  pendingSubmission: PendingSubmissionSnapshot;
  accountState?: LiveAccountState;
}) {
  const { pendingSubmission } = input;
  if (
    (pendingSubmission.orderAction !== 'withdraw-lp' && pendingSubmission.orderAction !== 'claim-fee')
    || !pendingSubmission.tokenMint
    || pendingSubmission.preExitTokenAmountRaw === undefined
  ) {
    return {
      trusted: false as const,
      reason: 'lp-exit-reconcile-required:residual-ownership-baseline-missing'
    };
  }

  const postExitRaw = sumWalletTokenRaw(input.accountState, pendingSubmission.tokenMint);
  if (postExitRaw === undefined) {
    return {
      trusted: false as const,
      reason: 'lp-exit-reconcile-required:post-exit-token-raw-unavailable'
    };
  }

  const preExitRaw = BigInt(pendingSubmission.preExitTokenAmountRaw);
  if (postExitRaw < preExitRaw) {
    return {
      trusted: false as const,
      reason: 'lp-exit-reconcile-required:pre-existing-wallet-token-balance-changed'
    };
  }

  const ownedResidualRaw = postExitRaw - preExitRaw;
  const reportedResidualRawText = pendingSubmission.residualUnsoldAmountsRaw?.[pendingSubmission.tokenMint];
  const reportedResidualRaw = reportedResidualRawText && /^\d+$/.test(reportedResidualRawText)
    ? BigInt(reportedResidualRawText)
    : undefined;

  if (
    pendingSubmission.residualSweepStatus === 'incomplete'
    && (reportedResidualRaw === undefined || reportedResidualRaw !== ownedResidualRaw || ownedResidualRaw <= 0n)
  ) {
    return {
      trusted: false as const,
      reason: 'lp-exit-reconcile-required:reported-residual-amount-mismatch'
    };
  }

  if (
    pendingSubmission.residualSweepStatus === 'complete'
    && (ownedResidualRaw > 0n || (reportedResidualRaw !== undefined && reportedResidualRaw > 0n))
  ) {
    return {
      trusted: false as const,
      reason: 'lp-exit-reconcile-required:cleanup-complete-but-residual-remains'
    };
  }

  if (reportedResidualRaw !== undefined && reportedResidualRaw !== ownedResidualRaw) {
    return {
      trusted: false as const,
      reason: 'lp-exit-reconcile-required:reported-residual-amount-mismatch'
    };
  }

  const cleanupStatus = pendingSubmission.residualSweepStatus === 'dust_ignored'
    ? 'residual_dust_ignored'
    : ownedResidualRaw > 0n
      ? 'residual_cleanup_pending'
      : 'residual_cleanup_complete';
  return {
    trusted: true as const,
    cleanupStatus,
    cleanupAmountRaw: ownedResidualRaw > 0n ? ownedResidualRaw.toString() : undefined
  };
}

function hasPersistedActiveLifecycleTarget(positionState?: PositionStateSnapshot | null) {
  return Boolean(
    positionState
    && positionState.lifecycleState
    && positionState.lifecycleState !== 'closed'
    && (
      positionState.chainPositionAddress
      || (positionState.activeMint && positionState.activePoolAddress)
      || positionState.activeMint
    )
  );
}

function reconcileTerminalFlatPositionState(input: {
  positionState?: PositionStateSnapshot;
  accountState?: LiveAccountState;
  pendingSubmission: boolean;
  allowNewOpens: boolean;
  flattenOnly: boolean;
  now: string;
}) {
  if (input.pendingSubmission || !input.accountState || hasOpenInventory(input.accountState)) {
    return input.positionState;
  }

  if (!input.positionState) {
    return undefined;
  }

  if (
    input.positionState.lifecycleState === 'closed' &&
    !input.positionState.activeMint &&
    !input.positionState.activePoolAddress &&
    !input.positionState.openIntentId &&
    !input.positionState.positionId &&
    !input.positionState.chainPositionAddress
  ) {
    return input.positionState;
  }

  return {
    ...input.positionState,
    allowNewOpens: input.allowNewOpens,
    flattenOnly: input.flattenOnly,
    lastReason: 'account-terminal-flat',
    openIntentId: undefined,
    positionId: undefined,
    chainPositionAddress: undefined,
    activeMint: undefined,
    activePoolAddress: undefined,
    lifecycleState: 'closed' as const,
    ownedTokenAmountRaw: undefined,
    entrySol: undefined,
    entrySolSource: undefined,
    entryFillSubmissionId: undefined,
    openedAt: undefined,
    valuationStatus: undefined,
    valuationReason: undefined,
    lastValuationAt: undefined,
    lastClosedMint: input.positionState.activeMint ?? input.positionState.lastClosedMint,
    lastClosedAt: input.positionState.activeMint || input.positionState.activePoolAddress
      ? input.now
      : input.positionState.lastClosedAt,
    walletSol: input.accountState.walletSol,
    updatedAt: input.now
  };
}

function inferOpenPositionMetadata(input: {
  accountState?: LiveAccountState;
  activeMint?: string;
  activePoolAddress?: string;
  existingEntrySol?: number;
  existingEntrySolSource?: PositionStateSnapshot['entrySolSource'];
  existingEntryFillSubmissionId?: string;
  existingOpenedAt?: string;
  fallbackOpenedAt?: string;
}) {
  let entrySol = isTrustedEntrySolSource(input.existingEntrySolSource) && typeof input.existingEntrySol === 'number'
    ? input.existingEntrySol
    : undefined;
  let entrySolSource = entrySol !== undefined ? input.existingEntrySolSource : undefined;
  let entryFillSubmissionId = entrySol !== undefined ? input.existingEntryFillSubmissionId : undefined;
  let openedAt = input.existingOpenedAt;

  if ((entrySol !== undefined && openedAt) || !input.accountState) {
    return { entrySol, entrySolSource, entryFillSubmissionId, openedAt };
  }

  const lpPosition = (input.accountState.walletLpPositions ?? []).find((position) => {
    if (!isManageableLpPosition(position)) {
      return false;
    }

    return (input.activeMint && position.mint === input.activeMint)
      || (input.activePoolAddress && position.poolAddress === input.activePoolAddress);
  });

  if (lpPosition) {
    return { entrySol, entrySolSource, entryFillSubmissionId, openedAt };
  }

  return { entrySol, entrySolSource, entryFillSubmissionId, openedAt };
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
    const exact = positions.find((position) =>
      position.positionAddress === input.chainPositionAddress
      || position.chainPositionAddress === input.chainPositionAddress
    );
    if (exact) {
      return exact;
    }

    // chainPositionAddress is lost from account → LP was exited.
    // Never fall back to arbitrary other LP positions.
    return undefined;
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

function resolvePersistedActiveTarget(input: {
  positionState?: Awaited<ReturnType<RuntimeStateStore['readPositionState']>>;
  pendingSubmission: Awaited<ReturnType<PendingSubmissionStore['read']>>;
  accountState?: LiveAccountState;
  resultContextMint: string;
  resultContextPoolAddress: string;
  liveOrderSubmitted: boolean;
  action: string;
}) {
  const shouldPreservePriorOpenTarget = Boolean(
    input.positionState?.lifecycleState !== undefined
    && input.positionState.lifecycleState !== 'closed'
    && input.positionState.activeMint
    && input.positionState.activePoolAddress
    && !input.liveOrderSubmitted
    && !isOpeningActionName(input.action)
  );
  let activeMint = shouldPreservePriorOpenTarget
    ? (input.positionState?.activeMint ?? input.resultContextMint)
    : input.resultContextMint;
  let activePoolAddress = shouldPreservePriorOpenTarget
    ? (input.positionState?.activePoolAddress ?? input.resultContextPoolAddress)
    : (input.resultContextPoolAddress || input.positionState?.activePoolAddress || '');

  const fullExitSucceeded = isFullExitAction(input.action as LiveAction) && input.liveOrderSubmitted;

  const boundPosition = fullExitSucceeded
    ? undefined
    : resolveBoundLpPosition({
        accountState: input.accountState,
        chainPositionAddress: input.positionState?.chainPositionAddress || input.pendingSubmission?.chainPositionAddress,
        activeMint,
        activePoolAddress
      });

  if (boundPosition) {
    const actionOpenedNewPosition = isOpeningActionName(input.action) && input.liveOrderSubmitted;
    const boundMatchesRequestedTarget = Boolean(
      activeMint &&
      activePoolAddress &&
      boundPosition.mint === activeMint &&
      boundPosition.poolAddress === activePoolAddress
    );

    if (!actionOpenedNewPosition || boundMatchesRequestedTarget || (!activeMint && !activePoolAddress)) {
      activeMint = boundPosition.mint;
      activePoolAddress = boundPosition.poolAddress;
    }
  }

  return { activeMint, activePoolAddress };
}

function resolvePersistedLpIdentity(input: {
  lifecycleState?: PositionLifecycleState;
  pendingSubmission: Awaited<ReturnType<PendingSubmissionStore['read']>>;
  positionState?: Awaited<ReturnType<RuntimeStateStore['readPositionState']>>;
  accountState?: LiveAccountState;
  activeMint?: string;
  activePoolAddress?: string;
  action?: string;
  liveOrderSubmitted?: boolean;
}) {
  const actionOpenedNewPosition = isOpeningActionName(input.action) && input.liveOrderSubmitted === true;
  const priorStateMatchesTarget = positionStateTargetMatches(input);
  const ignorePriorStateIdentity = actionOpenedNewPosition && !priorStateMatchesTarget;
  const priorChainPositionAddress = ignorePriorStateIdentity
    ? input.pendingSubmission?.chainPositionAddress
    : input.positionState?.chainPositionAddress || input.pendingSubmission?.chainPositionAddress;
  const boundPosition = resolveBoundLpPosition({
    accountState: input.accountState,
    chainPositionAddress: priorChainPositionAddress,
    activeMint: input.activeMint,
    activePoolAddress: input.activePoolAddress
  });
  const chainPositionAddress = boundPosition?.positionAddress
    || (!ignorePriorStateIdentity ? input.positionState?.chainPositionAddress : undefined)
    || input.pendingSubmission?.chainPositionAddress;

  if (input.lifecycleState === 'closed') {
    return {
      openIntentId: undefined,
      positionId: undefined,
      chainPositionAddress: undefined,
      valuationStatus: undefined,
      valuationReason: undefined,
      valuationTrust: undefined,
      valuationSource: undefined,
      valuationCompleteness: undefined,
      exitQuoteValueSol: undefined,
      marketValueSol: undefined,
      displayValueSol: undefined,
      lpTotalValueSol: undefined,
      lastValuationAt: undefined
    };
  }

  return {
    openIntentId: input.pendingSubmission?.openIntentId || (!ignorePriorStateIdentity ? input.positionState?.openIntentId : undefined),
    positionId: chainPositionAddress
      ? createPositionId({ chainPositionAddress })
      : input.pendingSubmission?.positionId
        || (!ignorePriorStateIdentity ? input.positionState?.positionId : undefined)
        || ((input.activeMint || input.activePoolAddress)
          ? createPositionId({
              poolAddress: input.activePoolAddress,
              tokenMint: input.activeMint
            })
          : undefined),
    chainPositionAddress,
    valuationStatus: boundPosition?.valuationStatus ?? input.positionState?.valuationStatus,
    valuationReason: boundPosition?.valuationReason ?? input.positionState?.valuationReason,
    valuationTrust: boundPosition?.valuationTrust ?? input.positionState?.valuationTrust,
    valuationSource: boundPosition?.valuationSource ?? input.positionState?.valuationSource,
    valuationCompleteness: boundPosition?.valuationCompleteness ?? input.positionState?.valuationCompleteness,
    exitQuoteValueSol: boundPosition?.exitQuoteValueSol ?? input.positionState?.exitQuoteValueSol,
    marketValueSol: boundPosition?.marketValueSol ?? input.positionState?.marketValueSol,
    displayValueSol: boundPosition?.displayValueSol ?? input.positionState?.displayValueSol,
    lpTotalValueSol: boundPosition?.lpTotalValueSol ?? input.positionState?.lpTotalValueSol,
    lastValuationAt: boundPosition?.lastValuationAt ?? input.positionState?.lastValuationAt
  };
}

function isOpeningActionName(action?: string) {
  return action === 'deploy' || action === 'add-lp';
}

export function resolveLifecycleStateForPersist(input: {
  nextLifecycleState?: PositionLifecycleState;
  previousLifecycleState?: PositionLifecycleState;
  pendingSubmission: boolean;
  accountState?: LiveAccountState;
  lastAction?: string;
  lastReason?: string;
  chainPositionAddress?: string;
  activeMint?: string;
  activePoolAddress?: string;
}): PositionLifecycleState {
  if (!input.accountState && !input.nextLifecycleState) {
    return input.previousLifecycleState ?? 'closed';
  }

  const hasInventory = hasOpenInventory(input.accountState);
  const hasMatchingPosition = hasMatchingLpPosition({
    accountState: input.accountState,
    chainPositionAddress: input.chainPositionAddress,
    activeMint: input.activeMint,
    activePoolAddress: input.activePoolAddress
  });
  const accountIsFlat = !input.pendingSubmission && !hasInventory && !hasMatchingPosition;
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

  if (
    input.previousLifecycleState === 'reconcile_required'
    && !accountIsFlat
  ) {
    return 'reconcile_required';
  }

  if (isPositionAlreadyClosedTerminal({
    action: input.lastAction,
    reason: input.lastReason,
    accountState: input.accountState,
    chainPositionAddress: input.chainPositionAddress,
    activeMint: input.activeMint,
    activePoolAddress: input.activePoolAddress
  })) {
    return 'closed';
  }

  if (accountIsFlat && !isOpeningActionName(input.lastAction)) {
    return 'closed';
  }

  if (isFullExitAction(input.lastAction as LiveAction) && input.nextLifecycleState === 'inventory_exit_ready') {
    return hasInventory ? 'inventory_exit_ready' : 'closed';
  }

  if (input.nextLifecycleState === 'closed' && hasInventory) {
    if (isFullExitAction(input.lastAction as LiveAction) && !hasMatchingPosition) {
      return 'closed';
    }
    return 'open';
  }

  if (input.nextLifecycleState === 'open_pending' && !input.pendingSubmission && (hasInventory || hasMatchingPosition)) {
    return 'open';
  }

  if (input.nextLifecycleState === 'inventory_exit_ready' && hasMatchingPosition) {
    return 'open';
  }

  if (isFullExitAction(input.lastAction as LiveAction) && hasMatchingPosition) {
    return 'lp_exit_pending';
  }

  if (pendingOpen) {
    return 'open_pending';
  }

  if (input.nextLifecycleState) {
    return input.nextLifecycleState;
  }

  if (!input.pendingSubmission && !hasInventory) {
    return 'closed';
  }

  if (historicalOnly) {
    return 'closed';
  }

  if (unresolvedOpen && (input.pendingSubmission || hasInventory || hasMatchingPosition)) {
    return 'open';
  }

  if (hasInventory || hasMatchingPosition) {
    return 'open';
  }

  return input.previousLifecycleState ?? 'closed';
}

export async function runLiveDaemon(options: LiveDaemonOptions) {
  const stateRootDir = options.stateRootDir ?? 'state';
  const journalRootDir = options.journalRootDir ?? 'tmp/journals';
  const tickIntervalMs = options.tickIntervalMs ?? 30_000;
  const hotTickIntervalMs = Math.min(options.hotTickIntervalMs ?? 3_000, tickIntervalMs);
  const rateLimitBackoffIntervalMs = options.rateLimitBackoffIntervalMs ?? Math.max(60_000, tickIntervalMs * 2);
  const residualTokenSweepIntervalMs = options.residualTokenSweepIntervalMs ?? DEFAULT_RESIDUAL_TOKEN_SWEEP_INTERVAL_MS;
  const residualTokenSweepCooldownMs = options.residualTokenSweepCooldownMs ?? DEFAULT_RESIDUAL_TOKEN_SWEEP_COOLDOWN_MS;
  const residualTokenSweepMinValueSol = options.residualTokenSweepMinValueSol ?? DEFAULT_RESIDUAL_TOKEN_SWEEP_MIN_VALUE_SOL;
  const sleep = options.sleep ?? wait;
  const maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY;
  const buildCycleInput:
    (
      tickCount: number,
      context?: LiveDaemonBuildCycleContext
    ) => Promise<Omit<LiveCycleInput, 'strategy'>> | Omit<LiveCycleInput, 'strategy'> =
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
  const preparedBroadcastStore = new PreparedBroadcastStore(stateRootDir);
  // Recovery and chain-entry reconstruction must be able to settle/release a
  // durable reservation even when the current invocation does not re-specify
  // an enforcement config. A missing file is an empty no-op store.
  const spendingLimitsStore = new SpendingLimitsStore(
    stateRootDir,
    options.spendingLimitsConfig?.dailySpendResetHour ?? 0
  );
  const residualTokenSweepStore = new ResidualTokenSweepStore(stateRootDir);
  const targetOpenCooldownStore = new TargetOpenCooldownStore(stateRootDir);
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
  let nextResidualTokenSweepAt = '';
  const lpEntryEvidenceCooldowns = new Map<string, string>();
  const reportedUnboundLpKeys = new Set<string>();
  const reportUnboundLpOwnership = async (ledger?: PositionLedgerSnapshot | null) => {
    for (const record of ledger?.records ?? []) {
      if (
        record.lastReason !== UNBOUND_ACCOUNT_LP_REASON
        || reportedUnboundLpKeys.has(record.positionKey)
      ) {
        continue;
      }
      reportedUnboundLpKeys.add(record.positionKey);
      try {
        await appendDaemonIncident({
          mirrorRuntime,
          strategyId: options.strategy,
          journalRootDir,
          runtimeMode: runtimeState.mode,
          stage: 'lp-ownership-reconciliation',
          reason: UNBOUND_ACCOUNT_LP_REASON,
          tokenMint: record.activeMint,
          poolAddress: record.activePoolAddress,
          chainPositionAddress: record.chainPositionAddress
        });
      } catch (error) {
        console.warn(
          `[LiveDaemon] LP ownership reconciliation incident write failed; continuing fail-closed without trading the orphan: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };

  await mirrorRuntime?.start();
  let warmedAccountState = await warmAccountProvider(options.accountProvider);

  // On startup, reconcile all active chain LP positions into the multi-LP
  // ledger.  The legacy position-state remains a compatibility summary only.
  if (warmedAccountState) {
    const startupPositionState = await runtimeStateStore.readPositionState();
    const startupLedger = importActiveLpPositionsToLedger({
      ledger: await runtimeStateStore.readPositionLedger(),
      positionState: startupPositionState,
      accountState: warmedAccountState,
      pendingSubmission: await pendingSubmissionStore.read(),
      closeMissingActive: true,
      now: nowIso()
    });
    await runtimeStateStore.writePositionLedger(startupLedger);
    await reportUnboundLpOwnership(startupLedger);
    const startupSummary = summarizePositionLedger(startupLedger);
    if (startupSummary.activeLpCount > 0) {
      console.log(
        `[LiveDaemon] Startup reconciliation: imported ${startupSummary.activeLpCount} active LP position(s) into position-ledger`
      );
      await runtimeStateStore.writePositionState(selectCompatibilityPositionState({
        ledger: startupLedger,
        pendingSubmission: await pendingSubmissionStore.read(),
        prior: startupPositionState,
        allowNewOpens: false,
        flattenOnly: false,
        lastAction: 'hold',
        lastReason: 'startup-ledger-reconciliation',
        walletSol: warmedAccountState.walletSol,
        now: nowIso()
      }));
      runtimeState = {
        ...runtimeState,
        mode: 'healthy' as RuntimeMode,
        circuitReason: '',
        cooldownUntil: '',
        transientAutoHealEligible: false,
        transientRecoverySuccessTicks: 0,
        updatedAt: nowIso()
      };
    }
  }

  try {
    while (tickCount < maxTicks) {
      tickCount += 1;
      let cycleInput: Omit<LiveCycleInput, 'strategy'> | undefined;
      let effectiveAccountState: LiveAccountState | undefined = warmedAccountState;
      warmedAccountState = undefined;
      let tickError: unknown;
      let pendingSubmission = await pendingSubmissionStore.read();
      let pendingSubmissionBeforeCycle = pendingSubmission;
      let resolvedPostTickSubmission: PendingSubmissionSnapshot | null = null;
      let positionState = await runtimeStateStore.readPositionState() ?? undefined;
      let positionLedger = await runtimeStateStore.readPositionLedger() ?? undefined;
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
          preparedBroadcastStore,
          spendingLimitsStore,
          broadcaster: options.broadcaster,
          accountProvider: options.accountProvider,
          confirmationProvider: options.confirmationProvider
        });
        pendingSubmission = preRecovery.pendingSubmission;
        effectiveAccountState = preRecovery.effectiveAccountState;
        positionState = await runtimeStateStore.readPositionState() ?? undefined;
        positionLedger = await runtimeStateStore.readPositionLedger() ?? undefined;
        const resolvedPreIngestSubmission = preRecovery.resolvedPendingSubmission;
        if (
          pendingSubmission === null &&
          resolvedPreIngestSubmission &&
          (preRecovery.recoveryReason === 'pending-submission-filled' || preRecovery.recoveryReason === 'pending-submission-confirmed')
        ) {
          if (resolvedPreIngestSubmission.orderAction === 'deploy') {
            const recoveredAt = nowIso();
            const recoveredOpenEvidence = resolveRecoveredSpotOpenEvidence({
              pendingSubmission: resolvedPreIngestSubmission,
              accountState: effectiveAccountState,
              recordedAt: recoveredAt
            });
            const recoveredFill = recoveredOpenEvidence.fill;
            const recoveredLifecycleState: PositionLifecycleState = recoveredFill
              ? 'open'
              : 'reconcile_required';
            if (recoveredFill?.actualFilledSol && spendingLimitsStore) {
              await spendingLimitsStore.settleSpend(
                resolvedPreIngestSubmission.idempotencyKey,
                recoveredFill.actualFilledSol
              );
            }
            positionState = {
              ...(positionState ?? {
                allowNewOpens: false,
                flattenOnly: false,
                lastAction: 'deploy',
                updatedAt: recoveredAt
              }),
              allowNewOpens: false,
              lastAction: 'deploy',
              lastReason: recoveredFill
                ? preRecovery.recoveryReason
                : recoveredOpenEvidence.failureReason
                  ?? 'spot-ownership-reconcile-required:recovered-open-evidence-missing',
              lastOrderIdempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
              openIntentId: resolvedPreIngestSubmission.openIntentId,
              positionId: resolvedPreIngestSubmission.positionId,
              chainPositionAddress: resolvedPreIngestSubmission.chainPositionAddress,
              activeMint: resolvedPreIngestSubmission.tokenMint,
              activePoolAddress: resolvedPreIngestSubmission.poolAddress,
              lifecycleState: recoveredLifecycleState,
              ownedTokenAmountRaw: recoveredFill?.acquiredTokenAmountRaw,
              entrySol: recoveredFill?.actualFilledSol,
              entrySolSource: recoveredFill ? 'actual_fill' : undefined,
              entryFillSubmissionId: recoveredFill?.submissionId,
              openedAt: recoveredFill?.recordedAt,
              walletSol: effectiveAccountState?.walletSol,
              updatedAt: recoveredAt
            };
            pendingSubmissionBeforeCycle = resolvedPreIngestSubmission;
            positionLedger = applyLiveCycleResultToLedger({
              ledger: positionLedger,
              positionState,
              accountState: effectiveAccountState,
              pendingSubmissionBeforeCycle: resolvedPreIngestSubmission,
              persistedPendingSubmission: null,
              actionIdentity: {
                openIntentId: resolvedPreIngestSubmission.openIntentId,
                positionId: resolvedPreIngestSubmission.positionId,
                chainPositionAddress: resolvedPreIngestSubmission.chainPositionAddress
              },
              orderIntent: {
                idempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                poolAddress: resolvedPreIngestSubmission.poolAddress,
                tokenMint: resolvedPreIngestSubmission.tokenMint
              },
              action: 'deploy',
              reason: positionState.lastReason ?? preRecovery.recoveryReason,
              liveOrderSubmitted: true,
              confirmationStatus: 'confirmed',
              confirmedFill: recoveredFill,
              now: recoveredAt
            });
            await runtimeStateStore.writePositionLedger(positionLedger);
            await runtimeStateStore.writePositionState(positionState);
          } else if (
            resolvedPreIngestSubmission.orderAction === 'dca-out'
            && (
              Boolean(positionState?.ownedTokenAmountRaw)
              || Boolean(resolvedPreIngestSubmission.openIntentId)
              || Boolean(
                resolvedPreIngestSubmission.positionId
                && !resolvedPreIngestSubmission.chainPositionAddress
                && !positionState?.chainPositionAddress
              )
            )
          ) {
            const recoveredAt = nowIso();
            const postExitTokenAmountRaw = sumWalletTokenRaw(
              effectiveAccountState,
              resolvedPreIngestSubmission.tokenMint
            );
            const preExitTokenAmountRaw = resolvedPreIngestSubmission.preExitTokenAmountRaw;
            const submittedInputAmountRaw = resolvedPreIngestSubmission.inputAmountRaw;
            const freshExactTokenDecrease = Boolean(
              preExitTokenAmountRaw
              && /^\d+$/.test(preExitTokenAmountRaw)
              && submittedInputAmountRaw
              && /^\d+$/.test(submittedInputAmountRaw)
              && postExitTokenAmountRaw !== undefined
              && hasCompleteFreshAccountSnapshot(resolvedPreIngestSubmission, effectiveAccountState)
              && BigInt(preExitTokenAmountRaw) >= postExitTokenAmountRaw
              && BigInt(preExitTokenAmountRaw) - postExitTokenAmountRaw === BigInt(submittedInputAmountRaw)
            );
            const exactOwnedExit = Boolean(
              positionState?.ownedTokenAmountRaw
              && resolvedPreIngestSubmission.inputAmountRaw === positionState.ownedTokenAmountRaw
              && freshExactTokenDecrease
            );
            pendingSubmissionBeforeCycle = resolvedPreIngestSubmission;
            if (exactOwnedExit && positionState) {
              positionLedger = applyLiveCycleResultToLedger({
                ledger: positionLedger,
                positionState,
                accountState: effectiveAccountState,
                pendingSubmissionBeforeCycle: resolvedPreIngestSubmission,
                persistedPendingSubmission: null,
                actionIdentity: {
                  openIntentId: resolvedPreIngestSubmission.openIntentId,
                  positionId: resolvedPreIngestSubmission.positionId,
                  chainPositionAddress: resolvedPreIngestSubmission.chainPositionAddress
                },
                orderIntent: {
                  idempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                  poolAddress: resolvedPreIngestSubmission.poolAddress,
                  tokenMint: resolvedPreIngestSubmission.tokenMint
                },
                action: 'dca-out',
                reason: preRecovery.recoveryReason,
                liveOrderSubmitted: true,
                confirmationStatus: 'confirmed',
                exitActionClosureProven: true,
                fullExitClosureProven: true,
                now: recoveredAt
              });
              positionState = {
                ...positionState,
                lastAction: 'dca-out',
                lastReason: preRecovery.recoveryReason,
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
                lastClosedMint: resolvedPreIngestSubmission.tokenMint ?? positionState.activeMint,
                lastClosedAt: recoveredAt,
                walletSol: effectiveAccountState?.walletSol,
                updatedAt: recoveredAt
              };
            } else {
              const reason = positionState?.ownedTokenAmountRaw
                ? freshExactTokenDecrease
                  ? 'spot-ownership-reconcile-required:recovered-exit-amount-mismatch'
                  : 'spot-ownership-reconcile-required:recovered-exit-token-delta-unproven'
                : 'spot-ownership-reconcile-required:recovered-exit-ownership-missing';
              positionState = {
                ...(positionState ?? {
                  allowNewOpens: false,
                  flattenOnly: false,
                  lastAction: 'dca-out',
                  updatedAt: recoveredAt
                }),
                allowNewOpens: false,
                lastAction: 'dca-out',
                lastReason: reason,
                lastOrderIdempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                openIntentId: resolvedPreIngestSubmission.openIntentId ?? positionState?.openIntentId,
                positionId: resolvedPreIngestSubmission.positionId ?? positionState?.positionId,
                chainPositionAddress: resolvedPreIngestSubmission.chainPositionAddress ?? positionState?.chainPositionAddress,
                activeMint: resolvedPreIngestSubmission.tokenMint ?? positionState?.activeMint,
                activePoolAddress: resolvedPreIngestSubmission.poolAddress || positionState?.activePoolAddress,
                lifecycleState: 'reconcile_required',
                updatedAt: recoveredAt
              };
              const matchingRecordIndex = positionLedger?.records.findIndex((record) =>
                (positionState?.openIntentId && record.openIntentId === positionState.openIntentId)
                || (positionState?.positionId && record.positionId === positionState.positionId)
              ) ?? -1;
              const reconcileRecord = {
                positionKey: positionLedgerKey({
                  chainPositionAddress: positionState.chainPositionAddress,
                  positionId: positionState.positionId,
                  openIntentId: positionState.openIntentId,
                  idempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                  poolAddress: positionState.activePoolAddress,
                  mint: positionState.activeMint
                }),
                openIntentId: positionState.openIntentId,
                idempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                positionId: positionState.positionId,
                chainPositionAddress: positionState.chainPositionAddress,
                activeMint: positionState.activeMint,
                activePoolAddress: positionState.activePoolAddress,
                lifecycleState: 'reconcile_required' as const,
                ownedTokenAmountRaw: positionState.ownedTokenAmountRaw,
                entrySol: positionState.entrySol,
                entrySolSource: positionState.entrySolSource,
                entryFillSubmissionId: positionState.entryFillSubmissionId,
                openedAt: positionState.openedAt,
                lastAction: 'dca-out',
                lastReason: reason,
                updatedAt: recoveredAt
              };
              const records = [...(positionLedger?.records ?? [])];
              if (matchingRecordIndex >= 0) {
                records[matchingRecordIndex] = { ...records[matchingRecordIndex], ...reconcileRecord };
              } else {
                records.push(reconcileRecord);
              }
              positionLedger = { version: 1, records, updatedAt: recoveredAt };
            }
            if (positionLedger) {
              await runtimeStateStore.writePositionLedger(positionLedger);
            }
            await runtimeStateStore.writePositionState(positionState);
          } else if (resolvedPreIngestSubmission.orderAction === 'dca-out') {
            // This is a maintenance sale of residual inventory rather than a
            // spot-position exit (spot exits carry position/open identities or
            // match positionState.ownedTokenAmountRaw in the branch above).
            // Bind completion to both the exact raw wallet delta and the exact
            // amount still owned by residual ledger records before clearing
            // the durable pending identity.
            const recoveredAt = nowIso();
            const mint = resolvedPreIngestSubmission.tokenMint;
            const inputAmountRaw = resolvedPreIngestSubmission.inputAmountRaw;
            const preExitTokenAmountRaw = resolvedPreIngestSubmission.preExitTokenAmountRaw;
            const postExitTokenAmountRaw = sumWalletTokenRaw(effectiveAccountState, mint);
            const matchingResidualRecords = (positionLedger?.records ?? []).filter((record) =>
              record.activeMint === mint
              && record.residualCleanupStatus === 'residual_cleanup_pending'
              && record.residualCleanupAmountRaw
              && /^\d+$/.test(record.residualCleanupAmountRaw)
            );
            const ledgerOwnedAmountRaw = matchingResidualRecords.reduce(
              (total, record) => total + BigInt(record.residualCleanupAmountRaw!),
              0n
            );
            const exactRawWalletDecrease = Boolean(
              inputAmountRaw
              && preExitTokenAmountRaw
              && postExitTokenAmountRaw !== undefined
              && hasCompleteFreshAccountSnapshot(resolvedPreIngestSubmission, effectiveAccountState)
              && BigInt(preExitTokenAmountRaw) >= postExitTokenAmountRaw
              && BigInt(preExitTokenAmountRaw) - postExitTokenAmountRaw === BigInt(inputAmountRaw)
            );
            const exactLedgerOwnership = Boolean(
              inputAmountRaw
              && matchingResidualRecords.length > 0
              && ledgerOwnedAmountRaw === BigInt(inputAmountRaw)
            );
            const trustedResidualExit = exactRawWalletDecrease && exactLedgerOwnership;
            const recoveryReason = trustedResidualExit
              ? preRecovery.recoveryReason
              : exactRawWalletDecrease
                ? 'residual-ownership-reconcile-required:recovered-exit-amount-mismatch'
                : 'residual-ownership-reconcile-required:recovered-exit-token-delta-unproven';
            const records = [...(positionLedger?.records ?? [])];
            let matchedRecord = false;
            for (let index = 0; index < records.length; index += 1) {
              const record = records[index];
              if (
                record.activeMint !== mint
                || record.residualCleanupStatus !== 'residual_cleanup_pending'
              ) {
                continue;
              }
              matchedRecord = true;
              records[index] = trustedResidualExit
                ? {
                    ...record,
                    lifecycleState: record.lastAction === 'withdraw-lp'
                      || record.lifecycleState === 'lp_exit_pending'
                      || record.lifecycleState === 'inventory_exit_pending'
                      || record.lifecycleState === 'inventory_exit_ready'
                      ? 'closed'
                      : record.lifecycleState,
                    residualCleanupStatus: 'residual_cleanup_complete',
                    residualCleanupAmountRaw: undefined,
                    lastReason: recoveryReason,
                    updatedAt: recoveredAt
                  }
                : {
                    ...record,
                    lifecycleState: 'reconcile_required',
                    lastReason: recoveryReason,
                    evidenceMissingReason: recoveryReason,
                    updatedAt: recoveredAt
                  };
            }
            if (!matchedRecord) {
              records.push({
                positionKey: `residual-recovery:${mint || resolvedPreIngestSubmission.idempotencyKey}`,
                idempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                activeMint: mint,
                activePoolAddress: resolvedPreIngestSubmission.poolAddress,
                lifecycleState: 'reconcile_required',
                residualCleanupStatus: 'residual_cleanup_pending',
                residualCleanupAmountRaw: inputAmountRaw,
                lastAction: 'dca-out',
                lastReason: 'residual-ownership-reconcile-required:ledger-record-missing',
                evidenceMissingReason: 'residual-ownership-reconcile-required:ledger-record-missing',
                updatedAt: recoveredAt
              });
            }
            positionLedger = {
              version: 1,
              records,
              updatedAt: recoveredAt
            };
            pendingSubmissionBeforeCycle = resolvedPreIngestSubmission;
            await runtimeStateStore.writePositionLedger(positionLedger);
          } else if (resolvedPreIngestSubmission.orderAction === 'add-lp') {
            const recoveredAt = nowIso();
            const activeLpCandidates = collectActiveLpPositions(effectiveAccountState).filter((position) => {
              const chainPositionAddress = position.chainPositionAddress || position.positionAddress;
              if (resolvedPreIngestSubmission.chainPositionAddress) {
                return chainPositionAddress === resolvedPreIngestSubmission.chainPositionAddress;
              }
              return position.poolAddress === resolvedPreIngestSubmission.poolAddress
                && position.mint === resolvedPreIngestSubmission.tokenMint;
            });
            const recoveredLp = activeLpCandidates.length === 1 ? activeLpCandidates[0] : undefined;
            const recoveredChainPositionAddress = recoveredLp?.chainPositionAddress || recoveredLp?.positionAddress;
            const actualFilledSol = typeof resolvedPreIngestSubmission.preEntryWalletSol === 'number'
              && typeof effectiveAccountState?.walletSol === 'number'
              ? resolvedPreIngestSubmission.preEntryWalletSol - effectiveAccountState.walletSol
              : undefined;
            const recoveredFill: LiveCycleConfirmedFill | undefined = recoveredLp
              && typeof actualFilledSol === 'number'
              && Number.isFinite(actualFilledSol)
              && actualFilledSol > 0
              && recoveredOpenWalletDeltaIsPlausible(resolvedPreIngestSubmission, actualFilledSol)
              ? {
                  submissionId: resolvedPreIngestSubmission.submissionId,
                  mint: resolvedPreIngestSubmission.tokenMint ?? recoveredLp.mint,
                  side: 'add-lp',
                  filledSol: actualFilledSol,
                  actualFilledSol,
                  actualWalletDeltaSol: -actualFilledSol,
                  fillAmountSource: 'wallet-delta',
                  recordedAt: recoveredAt,
                  hasFillEvidence: true
                }
              : undefined;
            const trustedRecoveredLp = Boolean(recoveredFill && recoveredChainPositionAddress);
            const recoveryReason = trustedRecoveredLp
              ? preRecovery.recoveryReason
              : 'lp-open-reconcile-required:recovered-open-evidence-missing';
            if (recoveredFill?.actualFilledSol && spendingLimitsStore) {
              await spendingLimitsStore.settleSpend(
                resolvedPreIngestSubmission.idempotencyKey,
                recoveredFill.actualFilledSol
              );
            }
            positionState = {
              ...(positionState ?? {
                allowNewOpens: false,
                flattenOnly: false,
                lastAction: 'add-lp',
                updatedAt: recoveredAt
              }),
              allowNewOpens: false,
              lastAction: 'add-lp',
              lastReason: recoveryReason,
              lastOrderIdempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
              openIntentId: resolvedPreIngestSubmission.openIntentId,
              positionId: recoveredChainPositionAddress
                ? createPositionId({ chainPositionAddress: recoveredChainPositionAddress })
                : resolvedPreIngestSubmission.positionId,
              chainPositionAddress: recoveredChainPositionAddress ?? resolvedPreIngestSubmission.chainPositionAddress,
              activeMint: recoveredLp?.mint ?? resolvedPreIngestSubmission.tokenMint,
              activePoolAddress: recoveredLp?.poolAddress ?? resolvedPreIngestSubmission.poolAddress,
              lifecycleState: trustedRecoveredLp ? 'open' : 'reconcile_required',
              entrySol: recoveredFill?.actualFilledSol,
              entrySolSource: recoveredFill ? 'actual_fill' : undefined,
              entryFillSubmissionId: recoveredFill?.submissionId,
              openedAt: recoveredFill?.recordedAt,
              walletSol: effectiveAccountState?.walletSol,
              updatedAt: recoveredAt
            };
            pendingSubmissionBeforeCycle = resolvedPreIngestSubmission;
            positionLedger = applyLiveCycleResultToLedger({
              ledger: positionLedger,
              positionState,
              accountState: effectiveAccountState,
              pendingSubmissionBeforeCycle: resolvedPreIngestSubmission,
              persistedPendingSubmission: null,
              actionIdentity: {
                openIntentId: positionState.openIntentId,
                positionId: positionState.positionId,
                chainPositionAddress: positionState.chainPositionAddress
              },
              orderIntent: {
                idempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                poolAddress: positionState.activePoolAddress,
                tokenMint: positionState.activeMint
              },
              action: 'add-lp',
              reason: recoveryReason,
              liveOrderSubmitted: true,
              confirmationStatus: 'confirmed',
              confirmedFill: recoveredFill,
              now: recoveredAt
            });
            if (!trustedRecoveredLp) {
              positionLedger = {
                ...positionLedger,
                records: positionLedger.records.map((record) =>
                  (positionState?.openIntentId && record.openIntentId === positionState.openIntentId)
                    || (positionState?.positionId && record.positionId === positionState.positionId)
                    ? { ...record, lifecycleState: 'reconcile_required' as const, lastReason: recoveryReason, updatedAt: recoveredAt }
                    : record
                ),
                updatedAt: recoveredAt
              };
            }
            await runtimeStateStore.writePositionLedger(positionLedger);
            await runtimeStateStore.writePositionState(positionState);
          } else if (resolvedPreIngestSubmission.orderAction === 'withdraw-lp') {
            const recoveredAt = nowIso();
            const closureProven = hasFreshCompleteLpExitAbsenceEvidence(
              resolvedPreIngestSubmission,
              effectiveAccountState
            );
            const residualEvidence = closureProven
              ? resolveRecoveredLpResidualEvidence({
                  pendingSubmission: resolvedPreIngestSubmission,
                  accountState: effectiveAccountState
                })
              : {
                  trusted: false as const,
                  reason: 'lp-exit-reconcile-required:recovered-exit-absence-unproven'
                };
            const recoveryReason = residualEvidence.trusted
              ? preRecovery.recoveryReason
              : residualEvidence.reason;
            pendingSubmissionBeforeCycle = resolvedPreIngestSubmission;
            positionLedger = applyLiveCycleResultToLedger({
              ledger: positionLedger,
              positionState,
              accountState: effectiveAccountState,
              pendingSubmissionBeforeCycle: resolvedPreIngestSubmission,
              persistedPendingSubmission: null,
              actionIdentity: {
                openIntentId: resolvedPreIngestSubmission.openIntentId,
                positionId: resolvedPreIngestSubmission.positionId,
                chainPositionAddress: resolvedPreIngestSubmission.chainPositionAddress
              },
              orderIntent: {
                idempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                poolAddress: resolvedPreIngestSubmission.poolAddress,
                tokenMint: resolvedPreIngestSubmission.tokenMint
              },
              action: 'withdraw-lp',
              reason: recoveryReason,
              liveOrderSubmitted: true,
              confirmationStatus: 'confirmed',
              exitActionClosureProven: Boolean(
                closureProven
                && residualEvidence.trusted
              ),
              fullExitClosureProven: Boolean(
                closureProven
                && residualEvidence.trusted
                && (
                  residualEvidence.cleanupStatus === 'residual_cleanup_complete'
                  || residualEvidence.cleanupStatus === 'residual_dust_ignored'
                )
              ),
              residualCleanupStatus: residualEvidence.trusted
                ? residualEvidence.cleanupStatus
                : undefined,
              residualCleanupAmountRaw: residualEvidence.trusted
                ? residualEvidence.cleanupAmountRaw
                : undefined,
              now: recoveredAt
            });

            if (!residualEvidence.trusted) {
              const recordMatches = (record: PositionLedgerSnapshot['records'][number]) => Boolean(
                (resolvedPreIngestSubmission.chainPositionAddress && (
                  record.chainPositionAddress === resolvedPreIngestSubmission.chainPositionAddress
                  || record.positionKey === `chain-position:${resolvedPreIngestSubmission.chainPositionAddress}`
                ))
                || (resolvedPreIngestSubmission.openIntentId && record.openIntentId === resolvedPreIngestSubmission.openIntentId)
                || (resolvedPreIngestSubmission.positionId && record.positionId === resolvedPreIngestSubmission.positionId)
                || (
                  resolvedPreIngestSubmission.poolAddress
                  && resolvedPreIngestSubmission.tokenMint
                  && record.activePoolAddress === resolvedPreIngestSubmission.poolAddress
                  && record.activeMint === resolvedPreIngestSubmission.tokenMint
                )
              );
              positionLedger = {
                ...positionLedger,
                records: positionLedger.records.map((record) => recordMatches(record)
                  ? {
                      ...record,
                      lifecycleState: 'reconcile_required' as const,
                      residualCleanupStatus: undefined,
                      residualCleanupAmountRaw: undefined,
                      lastReason: recoveryReason,
                      evidenceMissingReason: recoveryReason,
                      updatedAt: recoveredAt
                    }
                  : record),
                updatedAt: recoveredAt
              };
              positionState = {
                ...(positionState ?? {
                  allowNewOpens: false,
                  flattenOnly: false,
                  lastAction: 'withdraw-lp',
                  updatedAt: recoveredAt
                }),
                allowNewOpens: false,
                lastAction: 'withdraw-lp',
                lastReason: recoveryReason,
                lastOrderIdempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                openIntentId: resolvedPreIngestSubmission.openIntentId ?? positionState?.openIntentId,
                positionId: resolvedPreIngestSubmission.positionId ?? positionState?.positionId,
                chainPositionAddress: resolvedPreIngestSubmission.chainPositionAddress ?? positionState?.chainPositionAddress,
                activeMint: resolvedPreIngestSubmission.tokenMint ?? positionState?.activeMint,
                activePoolAddress: resolvedPreIngestSubmission.poolAddress || positionState?.activePoolAddress,
                lifecycleState: 'reconcile_required',
                walletSol: effectiveAccountState?.walletSol,
                updatedAt: recoveredAt
              };
            } else {
              positionState = selectCompatibilityPositionState({
                ledger: positionLedger,
                pendingSubmission: null,
                prior: {
                  ...(positionState ?? {
                    allowNewOpens: false,
                    flattenOnly: false,
                    lastAction: 'withdraw-lp',
                    updatedAt: recoveredAt
                  }),
                  lastAction: 'withdraw-lp',
                  lastReason: recoveryReason,
                  lastOrderIdempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
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
                  lastClosedMint: resolvedPreIngestSubmission.tokenMint ?? positionState?.activeMint,
                  lastClosedAt: recoveredAt,
                  walletSol: effectiveAccountState?.walletSol,
                  updatedAt: recoveredAt
                },
                advance: true,
                allowNewOpens: false,
                flattenOnly: positionState?.flattenOnly ?? false,
                lastAction: 'withdraw-lp',
                lastReason: recoveryReason,
                walletSol: effectiveAccountState?.walletSol,
                now: recoveredAt
              });
            }
            await runtimeStateStore.writePositionLedger(positionLedger);
            await runtimeStateStore.writePositionState(positionState);
          } else if (resolvedPreIngestSubmission.orderAction === 'claim-fee') {
            const recoveredAt = nowIso();
            const residualEvidence = hasCompleteFreshAccountSnapshot(
              resolvedPreIngestSubmission,
              effectiveAccountState
            )
              ? resolveRecoveredLpResidualEvidence({
                  pendingSubmission: resolvedPreIngestSubmission,
                  accountState: effectiveAccountState
                })
              : {
                  trusted: false as const,
                  reason: 'lp-exit-reconcile-required:post-claim-account-snapshot-unavailable'
                };
            const recoveryReason = residualEvidence.trusted
              ? preRecovery.recoveryReason
              : residualEvidence.reason;
            pendingSubmissionBeforeCycle = resolvedPreIngestSubmission;
            positionLedger = applyLiveCycleResultToLedger({
              ledger: positionLedger,
              positionState,
              accountState: effectiveAccountState,
              pendingSubmissionBeforeCycle: resolvedPreIngestSubmission,
              persistedPendingSubmission: null,
              actionIdentity: {
                openIntentId: resolvedPreIngestSubmission.openIntentId,
                positionId: resolvedPreIngestSubmission.positionId,
                chainPositionAddress: resolvedPreIngestSubmission.chainPositionAddress
              },
              orderIntent: {
                idempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
                poolAddress: resolvedPreIngestSubmission.poolAddress,
                tokenMint: resolvedPreIngestSubmission.tokenMint
              },
              action: 'claim-fee',
              reason: recoveryReason,
              liveOrderSubmitted: true,
              confirmationStatus: 'confirmed',
              residualCleanupStatus: residualEvidence.trusted
                ? residualEvidence.cleanupStatus
                : undefined,
              residualCleanupAmountRaw: residualEvidence.trusted
                ? residualEvidence.cleanupAmountRaw
                : undefined,
              now: recoveredAt
            });
            const recordMatches = (record: PositionLedgerSnapshot['records'][number]) => Boolean(
              (resolvedPreIngestSubmission.chainPositionAddress && (
                record.chainPositionAddress === resolvedPreIngestSubmission.chainPositionAddress
                || record.positionKey === `chain-position:${resolvedPreIngestSubmission.chainPositionAddress}`
              ))
              || (resolvedPreIngestSubmission.openIntentId && record.openIntentId === resolvedPreIngestSubmission.openIntentId)
              || (resolvedPreIngestSubmission.positionId && record.positionId === resolvedPreIngestSubmission.positionId)
              || (
                resolvedPreIngestSubmission.poolAddress
                && resolvedPreIngestSubmission.tokenMint
                && record.activePoolAddress === resolvedPreIngestSubmission.poolAddress
                && record.activeMint === resolvedPreIngestSubmission.tokenMint
              )
            );
            if (!residualEvidence.trusted) {
              positionLedger = {
                ...positionLedger,
                records: positionLedger.records.map((record) => recordMatches(record)
                  ? {
                      ...record,
                      lifecycleState: 'reconcile_required' as const,
                      residualCleanupStatus: undefined,
                      residualCleanupAmountRaw: undefined,
                      lastReason: recoveryReason,
                      evidenceMissingReason: recoveryReason,
                      updatedAt: recoveredAt
                    }
                  : record),
                updatedAt: recoveredAt
              };
            }
            positionState = {
              ...(positionState ?? {
                allowNewOpens: false,
                flattenOnly: false,
                lastAction: 'claim-fee',
                updatedAt: recoveredAt
              }),
              allowNewOpens: false,
              lastAction: 'claim-fee',
              lastReason: recoveryReason,
              lastOrderIdempotencyKey: resolvedPreIngestSubmission.idempotencyKey,
              openIntentId: resolvedPreIngestSubmission.openIntentId ?? positionState?.openIntentId,
              positionId: resolvedPreIngestSubmission.positionId ?? positionState?.positionId,
              chainPositionAddress: resolvedPreIngestSubmission.chainPositionAddress ?? positionState?.chainPositionAddress,
              activeMint: resolvedPreIngestSubmission.tokenMint ?? positionState?.activeMint,
              activePoolAddress: resolvedPreIngestSubmission.poolAddress || positionState?.activePoolAddress,
              lifecycleState: residualEvidence.trusted ? (positionState?.lifecycleState ?? 'open') : 'reconcile_required',
              walletSol: effectiveAccountState?.walletSol,
              updatedAt: recoveredAt
            };
            await runtimeStateStore.writePositionLedger(positionLedger);
            await runtimeStateStore.writePositionState(positionState);
          }
        }
        if (
          resolvedPreIngestSubmission
          && preRecovery.recoveryReason === 'pending-submission-failed'
          && resolvedPreIngestSubmission.orderAction
          && classifyAction(resolvedPreIngestSubmission.orderAction) === 'open_risk'
        ) {
          // A submitted open that later fails on-chain consumed no position
          // capital. Release its durable reservation before erasing the
          // pending identity; releaseSpend is idempotent across crashes.
          await spendingLimitsStore.releaseSpend(
            resolvedPreIngestSubmission.idempotencyKey,
            resolvedPreIngestSubmission.requestedPositionSol
          );
        }
        if (resolvedPreIngestSubmission) {
          // The recovered business state is now durable (or the submission
          // resolved as failed), so the pending identity can be cleared.
          await pendingSubmissionStore.clear();
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

        if (!effectiveAccountState && options.accountProvider) {
          effectiveAccountState = await options.accountProvider.readState();
        }

        positionLedger = importActiveLpPositionsToLedger({
          ledger: positionLedger,
          positionState,
          accountState: effectiveAccountState,
          pendingSubmission,
          now: nowIso()
        });
        await runtimeStateStore.writePositionLedger(positionLedger);
        await reportUnboundLpOwnership(positionLedger);
        effectiveAccountState = suppressClosedLedgerLpPositions({
          accountState: effectiveAccountState,
          ledger: positionLedger
        });

        if (options.signer && options.broadcaster) {
          const preIngestResidualSweepResult = await runResidualTokenSweepIfDue({
            strategy: options.strategy,
            executionPolicy: options.captureMode === 'mechanical-soak' || options.captureMode === 'economic-shadow'
              ? 'simulate-only'
              : 'broadcast',
            captureMode: options.captureMode,
            maxSlippageBps: options.residualSweepMaxSlippageBps ?? 100,
            maxImpactBps: options.residualSweepMaxImpactBps ?? 200,
            accountState: effectiveAccountState,
            positionLedger,
            runtimeMode: runtimeState.mode,
            runtimeReason: runtimeState.circuitReason,
            pendingSubmission: hasPendingSubmission,
            signer: options.signer,
            broadcaster: options.broadcaster,
            confirmationProvider: options.confirmationProvider,
            dependencyHealth,
            residualTokenSweepStore,
            residualTokenSweepIntervalMs,
            residualTokenSweepCooldownMs,
            residualTokenSweepMinValueSol,
            nextSweepAt: nextResidualTokenSweepAt,
            preparedBroadcastStore,
            pendingSubmissionStore
          });
          dependencyHealth = preIngestResidualSweepResult.dependencyHealth;
          nextResidualTokenSweepAt = preIngestResidualSweepResult.nextSweepAt;
          pendingSubmission = await pendingSubmissionStore.read();
          positionLedger = markResidualCleanupResolved(
            positionLedger,
            preIngestResidualSweepResult.resolvedMints,
            nowIso()
          );
          if (preIngestResidualSweepResult.resolvedMints.length > 0 && positionLedger) {
            await runtimeStateStore.writePositionLedger(positionLedger);
          }
        }

        const terminalFlatPositionState = reconcileTerminalFlatPositionState({
          positionState,
          accountState: effectiveAccountState,
          pendingSubmission: pendingSubmission !== null,
          allowNewOpens: runtimeState.mode === 'healthy' || runtimeState.mode === 'degraded',
          flattenOnly: runtimeState.mode === 'flatten_only',
          now: nowIso()
        });
        if (terminalFlatPositionState !== positionState) {
          positionState = terminalFlatPositionState;
          if (positionState) {
            await runtimeStateStore.writePositionState(positionState);
          }
        }

        // Auto-advance: when the tracked LP is gone but the account still
        // holds other LP positions, bind to the next one and continue
        // exiting before allowing any new opens.
        if (
          positionState?.lifecycleState === 'closed'
          && !positionState.activeMint
          && pendingSubmission === null
          && effectiveAccountState
        ) {
          const nextLp = resolveBoundLpPosition({
            accountState: effectiveAccountState,
            activeMint: positionState.activeMint,
            activePoolAddress: positionState.activePoolAddress
          });
          if (nextLp) {
            const token = [...(effectiveAccountState.walletTokens ?? []),
              ...(effectiveAccountState.journalTokens ?? [])
            ].find((t) => t.mint === nextLp.mint);
            const fill = [...(effectiveAccountState.fills ?? [])]
              .reverse()
              .find((f) => f.mint === nextLp.mint && f.symbol);
            positionState = {
              ...positionState,
              allowNewOpens: runtimeState.mode === 'healthy' || runtimeState.mode === 'degraded',
              flattenOnly: runtimeState.mode === 'flatten_only',
              lastReason: 'next-lp-advance',
              activeMint: nextLp.mint,
              activePoolAddress: nextLp.poolAddress,
              chainPositionAddress: nextLp.positionAddress,
              lifecycleState: 'open',
              valuationStatus: nextLp.valuationStatus,
              lastValuationAt: nextLp.lastValuationAt,
              updatedAt: nowIso()
            };
            await runtimeStateStore.writePositionState(positionState);
          }
        }

        if (positionState?.lifecycleState === 'open' && options.strategy === 'new-token-v1') {
          const boundPosition = resolveBoundLpPosition({
            accountState: effectiveAccountState,
            chainPositionAddress: positionState.chainPositionAddress,
            activeMint: positionState.activeMint,
            activePoolAddress: positionState.activePoolAddress
          });
          if (
            boundPosition &&
            (
              positionState.activeMint !== boundPosition.mint ||
              positionState.activePoolAddress !== boundPosition.poolAddress ||
              positionState.chainPositionAddress !== boundPosition.positionAddress ||
              positionState.positionId !== createPositionId({ chainPositionAddress: boundPosition.positionAddress })
            )
          ) {
            positionState = {
              ...positionState,
              activeMint: boundPosition.mint,
              activePoolAddress: boundPosition.poolAddress,
              positionId: createPositionId({ chainPositionAddress: boundPosition.positionAddress }),
              chainPositionAddress: boundPosition.positionAddress,
              updatedAt: nowIso()
            };
            await runtimeStateStore.writePositionState(positionState);
          }

          const journalFills = await readTrustedAddLpFills({
            strategy: options.strategy,
            journalRootDir
          });
          const trustedFills = [
            ...(effectiveAccountState?.fills ?? []),
            ...journalFills
          ];

          const canEvaluateEntryFillEvidence = Boolean(effectiveAccountState || journalFills.length > 0);
          const entryEvidenceProblem = canEvaluateEntryFillEvidence
            ? resolveTrustedEntryEvidenceProblem({
                positionState,
                fills: trustedFills
              })
            : undefined;

          if (entryEvidenceProblem) {
            const reason = entryEvidenceProblem === 'mismatch'
              ? 'entry-fill-target-mismatch: trusted LP entry fill belongs to a different active mint'
              : 'entry-fill-evidence-missing: trusted LP entry fill evidence is not locally verifiable';
            positionState = {
              ...positionState,
              entrySol: undefined,
              entrySolSource: undefined,
              entryFillSubmissionId: undefined,
              openedAt: undefined,
              valuationStatus: 'unavailable',
              valuationReason: entryEvidenceProblem === 'mismatch'
                ? 'entry-fill-target-mismatch'
                : 'entry-fill-evidence-missing',
              valuationTrust: undefined,
              valuationSource: undefined,
              valuationCompleteness: undefined,
              exitQuoteValueSol: undefined,
              marketValueSol: undefined,
              displayValueSol: undefined,
              lpTotalValueSol: undefined,
              updatedAt: nowIso()
            };
            await runtimeStateStore.writePositionState(positionState);
            await appendDaemonIncident({
              mirrorRuntime,
              strategyId: options.strategy,
              journalRootDir,
              runtimeMode: runtimeState.mode,
              stage: 'reconciliation',
              reason,
              tokenMint: positionState.activeMint,
              poolAddress: positionState.activePoolAddress,
              chainPositionAddress: positionState.chainPositionAddress
            });
          }

          if (!isTrustedEntrySolSource(positionState.entrySolSource)) {
            let repairedEntry = resolveTrustedEntryFromFills({
              positionState,
              fills: trustedFills
            });

            if (!repairedEntry && options.lpEntryEvidenceProvider && positionState.activeMint) {
              const evidenceKey = positionState.chainPositionAddress
                || positionState.positionId
                || `${positionState.activePoolAddress ?? ''}:${positionState.activeMint}`;
              const cooldownUntil = lpEntryEvidenceCooldowns.get(evidenceKey) ?? '';

              if (!cooldownUntil || cooldownUntil <= nowIso()) {
                lpEntryEvidenceCooldowns.set(
                  evidenceKey,
                  new Date(Date.now() + LP_ENTRY_EVIDENCE_COOLDOWN_MS).toISOString()
                );
                try {
                  const evidence = await options.lpEntryEvidenceProvider.reconstructEntry({
                    tokenMint: positionState.activeMint,
                    poolAddress: positionState.activePoolAddress,
                    chainPositionAddress: positionState.chainPositionAddress,
                    openedAtHint: positionState.openedAt,
                    orderSignature: positionState.lastOrderIdempotencyKey
                  });

                  if (evidence.status === 'trusted') {
                    const reconstructedEntry: TrustedLpEntryResolution = {
                      entrySol: evidence.entrySol,
                      entrySolSource: 'reconstructed_chain',
                      entryFillSubmissionId: evidence.signature,
                      openedAt: evidence.openedAt
                    };
                    if (positionState.lastOrderIdempotencyKey && spendingLimitsStore) {
                      await spendingLimitsStore.settleSpend(
                        positionState.lastOrderIdempotencyKey,
                        evidence.entrySol
                      );
                    }
                    await appendReconstructedEntryFill({
                      mirrorRuntime,
                      strategyId: options.strategy,
                      journalRootDir,
                      cycleId: `${options.strategy}:${nowIso()}`,
                      positionState,
                      entrySol: evidence.entrySol,
                      openedAt: evidence.openedAt,
                      signature: evidence.signature
                    });
                    repairedEntry = reconstructedEntry;
                  } else if (evidence.status === 'ambiguous') {
                    await appendDaemonIncident({
                      mirrorRuntime,
                      strategyId: options.strategy,
                      journalRootDir,
                      runtimeMode: runtimeState.mode,
                      stage: 'reconciliation',
                      reason: 'entry-reconstruction-ambiguous: active LP entry has multiple matching chain evidence records',
                      tokenMint: positionState.activeMint,
                      poolAddress: positionState.activePoolAddress,
                      chainPositionAddress: positionState.chainPositionAddress
                    });
                  } else {
                    await appendDaemonIncident({
                      mirrorRuntime,
                      strategyId: options.strategy,
                      journalRootDir,
                      runtimeMode: runtimeState.mode,
                      stage: 'reconciliation',
                      reason: 'orphaned-position-without-bound-entry: active LP entry chain evidence not found',
                      tokenMint: positionState.activeMint,
                      poolAddress: positionState.activePoolAddress,
                      chainPositionAddress: positionState.chainPositionAddress
                    });
                  }
                } catch {
                  await appendDaemonIncident({
                    mirrorRuntime,
                    strategyId: options.strategy,
                    journalRootDir,
                    runtimeMode: runtimeState.mode,
                    stage: 'reconciliation',
                    reason: 'orphaned-position-without-bound-entry: active LP entry reconstruction failed',
                    tokenMint: positionState.activeMint,
                    poolAddress: positionState.activePoolAddress,
                    chainPositionAddress: positionState.chainPositionAddress
                  });
                }
              }
            }

            if (trustedEntryChanged(positionState, repairedEntry)) {
              positionState = {
                ...positionState,
                entrySol: repairedEntry!.entrySol,
                entrySolSource: repairedEntry!.entrySolSource,
                entryFillSubmissionId: repairedEntry!.entryFillSubmissionId,
                openedAt: repairedEntry!.openedAt ?? positionState.openedAt,
                updatedAt: nowIso()
              };
              await runtimeStateStore.writePositionState(positionState);
            }
          }
        }

        const preCycleBusinessSemantics = resolvePositionBusinessSemantics({
          accountState: effectiveAccountState,
          positionState,
          positionLedger,
          pendingSubmission,
          residualTokenSweepMinValueSol,
          maxActivePositions: options.maxActivePositions ?? 5
        });
        const shouldStartMaintenancePass = Boolean(
          options.openAfterMaintenanceHold &&
          (
            preCycleBusinessSemantics.hasActiveLp
            || preCycleBusinessSemantics.residualDustState === 'dust_cleanup_pending'
            || hasPersistedActiveLifecycleTarget(positionState)
          )
        );
        // Gate the new-open pass only through the unified business semantics:
        // existing LPs are maintained independently, and capacity controls
        // whether more LP records may be opened.
        const activeLpCount = preCycleBusinessSemantics.activeLpCount;
        // A2: when a prior open has been submitted but the chain identity
        // is still confirming, suppress allowNewOpens so that no second
        // position can be opened before the first is fully settled.
        const priorOpenConfirming = Boolean(
          positionState?.lifecycleState === 'open'
          && positionState.activeMint
          && !positionState.chainPositionAddress
        );
        const allowNewOpens = preCycleBusinessSemantics.canOpenNewPosition.allowed
          && !priorOpenConfirming;
        const activeOpenCooldowns = await readActiveTargetOpenCooldowns({
          store: targetOpenCooldownStore,
          now: nowIso()
        });
        cycleInput = await buildCycleInput(tickCount, {
          tickCount,
          positionState,
          positionLedger,
          accountState: effectiveAccountState,
          selectionMode: shouldStartMaintenancePass
            ? 'maintenance-only'
            : 'default',
          openCooldowns: activeOpenCooldowns
        });
        effectiveAccountState = await resolveEffectiveAccountState(cycleInput, effectiveAccountState);
        const residualSuppression = await suppressCooldownResidualWalletTokens({
          accountState: effectiveAccountState,
          residualTokenSweepStore,
          residualTokenSweepMinValueSol,
          suppressAllEligibleResidualTokens: Boolean(nextResidualTokenSweepAt && nextResidualTokenSweepAt > nowIso()),
          nowIso: nowIso()
        });
        effectiveAccountState = residualSuppression.accountState;
        if (residualSuppression.suppressedMints.length > 0) {
          const residualBlockReason = `residual-sweep-cooldown:${residualSuppression.suppressedMints[0]}`;
          cycleInput = {
            ...cycleInput,
            context: {
              ...(cycleInput.context ?? {}),
              pool: {
                ...((cycleInput.context?.pool as Record<string, unknown> | undefined) ?? {}),
                blockReason: residualBlockReason
              },
              token: {
                ...((cycleInput.context?.token as Record<string, unknown> | undefined) ?? {}),
                blockReason: residualBlockReason
              },
              route: {
                ...((cycleInput.context?.route as Record<string, unknown> | undefined) ?? {}),
                blockReason: residualBlockReason
              }
            }
          };
        }
        pendingSubmission = await pendingSubmissionStore.read();
        pendingSubmissionBeforeCycle = pendingSubmission;
        positionState = await runtimeStateStore.readPositionState() ?? undefined;
        positionLedger = importActiveLpPositionsToLedger({
          ledger: await runtimeStateStore.readPositionLedger(),
          positionState,
          accountState: effectiveAccountState,
          pendingSubmission,
          closeMissingActive: true,
          updateRiskSentinel: false,
          now: nowIso()
        });
        await runtimeStateStore.writePositionLedger(positionLedger);
        await reportUnboundLpOwnership(positionLedger);
        effectiveAccountState = suppressClosedLedgerLpPositions({
          accountState: effectiveAccountState,
          ledger: positionLedger
        });
        const postSuppressionBusinessSemantics = resolvePositionBusinessSemantics({
          accountState: effectiveAccountState,
          positionState,
          positionLedger,
          pendingSubmission,
          residualTokenSweepMinValueSol,
          maxActivePositions: options.maxActivePositions ?? 5
        });
        let runtimeStateExplicitlySet = false;
        const confirmationProvider = cycleInput.confirmationProvider ?? options.confirmationProvider;
        const evolutionSink = cycleInput.evolutionSink ?? evolutionOutcomeStore;

        let result = await runLiveCycle({
          strategy: options.strategy,
          journalRootDir,
          stateRootDir,
          runtimeMode: runtimeState.mode,
          mirrorSink: mirrorRuntime,
          positionState,
          ...cycleInput,
          evolutionSink,
          accountState: effectiveAccountState,
          positionLedger,
          deferResolvedPendingClear: true,
          residualTokenSweepMinValueSol
        });

        await updateEvolutionWatchlistBestEffort({
          strategy: options.strategy,
          store: evolutionWatchlistStore,
          cycleInput,
          accountState: effectiveAccountState,
          now: new Date()
        });

        if (shouldStartMaintenancePass) {
          const pendingAfterMaintenance = await pendingSubmissionStore.read();
          const postMaintenanceBusinessSemantics = resolvePositionBusinessSemantics({
            accountState: effectiveAccountState,
            positionState,
            positionLedger,
            pendingSubmission: pendingAfterMaintenance,
            maintenanceOutcome: {
              action: result.action,
              reason: result.reason,
              liveOrderSubmitted: result.liveOrderSubmitted,
              failureKind: result.failureKind
            },
            residualTokenSweepMinValueSol,
            maxActivePositions: options.maxActivePositions ?? 5
          });
          const newOpenSkipReason = resolveNewOpenPassSkipReason({
            enabled: true,
            maintenanceResult: result,
            runtimeMode: runtimeState.mode,
            pendingSubmission: pendingAfterMaintenance !== null,
            accountState: effectiveAccountState,
            positionState,
            businessSemantics: postMaintenanceBusinessSemantics,
            maxActivePositions: options.maxActivePositions ?? 5,
            residualTokenSweepMinValueSol
          });

          if (newOpenSkipReason) {
            console.log(`[LiveDaemon] new-open-pass skipped reason=${newOpenSkipReason}`);
          } else if (!allowNewOpens) {
            console.log(`[LiveDaemon] new-open-pass blocked active-lp-count=${activeLpCount}`);
          } else {
            const skipMints = collectActiveExposureMints({
              accountState: effectiveAccountState,
              positionState
            });
            console.log(`[LiveDaemon] new-open-pass starting skipMints=${skipMints.join(',') || 'none'}`);
            let newOpenCycleInput = await buildCycleInput(tickCount, {
              tickCount,
              positionState,
              positionLedger,
              accountState: effectiveAccountState,
              selectionMode: 'new-open-only',
              skipMints,
              openCooldowns: activeOpenCooldowns
            });
            let newOpenAccountState = await resolveEffectiveAccountState(newOpenCycleInput, effectiveAccountState);
            const newOpenResidualSuppression = await suppressCooldownResidualWalletTokens({
              accountState: newOpenAccountState,
              residualTokenSweepStore,
              residualTokenSweepMinValueSol,
              suppressAllEligibleResidualTokens: Boolean(nextResidualTokenSweepAt && nextResidualTokenSweepAt > nowIso()),
              nowIso: nowIso()
            });
            newOpenAccountState = newOpenResidualSuppression.accountState;
            if (newOpenResidualSuppression.suppressedMints.length > 0) {
              const residualBlockReason = `residual-sweep-cooldown:${newOpenResidualSuppression.suppressedMints[0]}`;
              newOpenCycleInput = {
                ...newOpenCycleInput,
                context: {
                  ...(newOpenCycleInput.context ?? {}),
                  pool: {
                    ...((newOpenCycleInput.context?.pool as Record<string, unknown> | undefined) ?? {}),
                    blockReason: residualBlockReason
                  },
                  token: {
                    ...((newOpenCycleInput.context?.token as Record<string, unknown> | undefined) ?? {}),
                    blockReason: residualBlockReason
                  },
                  route: {
                    ...((newOpenCycleInput.context?.route as Record<string, unknown> | undefined) ?? {}),
                    blockReason: residualBlockReason
                  }
                }
              };
            }

            const newOpenResult = await runLiveCycle({
              strategy: options.strategy,
              journalRootDir,
              stateRootDir,
              runtimeMode: runtimeState.mode,
              mirrorSink: mirrorRuntime,
              ...newOpenCycleInput,
              evolutionSink,
              accountState: buildNewOpenExecutionAccountState(newOpenAccountState),
              positionState: undefined,
              residualTokenSweepMinValueSol
            });

            await recordTargetOpenCooldownForResult({
              result: newOpenResult,
              targetOpenCooldownStore
            });

            await updateEvolutionWatchlistBestEffort({
              strategy: options.strategy,
              store: evolutionWatchlistStore,
              cycleInput: newOpenCycleInput,
              accountState: newOpenAccountState,
              now: new Date()
            });

            if (shouldUseNewOpenPassResult(newOpenResult)) {
              console.log(`[LiveDaemon] new-open-pass selected action=${newOpenResult.action} reason=${newOpenResult.reason}`);
              result = newOpenResult;
              cycleInput = newOpenCycleInput;
              effectiveAccountState = newOpenAccountState;
            } else {
              console.log(`[LiveDaemon] new-open-pass observed no actionable candidate reason=${newOpenResult.reason}`);
            }
          }
        }

        if (options.onCycleResult) {
          try {
            await options.onCycleResult(result);
          } catch (error) {
            console.warn(`[LiveDaemon] optional cycle result sink failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

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

          await recordTargetOpenCooldownForResult({ result, targetOpenCooldownStore });

          if (
            result.failureKind === 'unknown' &&
            !isOpenPathTargetCooldownFailure({
              action: result.action,
              failureSource: result.failureSource,
              reason: result.reason
            })
          ) {
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
          if (result.action === 'dca-out') {
            await recordResidualCooldownForSellAttempt({
              result,
              residualTokenSweepStore,
              residualTokenSweepCooldownMs,
              now: new Date()
            });
          }
        }

        if (!result.liveOrderSubmitted && result.action === 'dca-out') {
          await recordResidualCooldownForSellAttempt({
            result,
            residualTokenSweepStore,
            residualTokenSweepCooldownMs,
            now: new Date()
          });
        }
        if (result.action === 'dca-out') {
          nextResidualTokenSweepAt = new Date(Date.now() + residualTokenSweepIntervalMs).toISOString();
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
        if (!postTickPendingSubmission && pendingSubmissionBeforeCycle) {
          pendingSubmission = null;
          pendingSubmissionBeforeCycle = null;
          runtimeState = {
            ...runtimeState,
            mode: runtimeState.mode === 'flatten_only' ? runtimeState.mode : 'healthy',
            circuitReason: runtimeState.mode === 'flatten_only' ? runtimeState.circuitReason : '',
            cooldownUntil: runtimeState.mode === 'flatten_only' ? runtimeState.cooldownUntil : '',
            transientAutoHealEligible: false,
            transientRecoverySuccessTicks: 0,
            updatedAt: nowIso()
          };
        }
        const currentCycleSubmissionClosureProven = Boolean(
          postTickPendingSubmission
          && result.submittedActionClosureProven === true
          && result.liveOrderSubmitted
          && result.orderIntent?.idempotencyKey === postTickPendingSubmission.idempotencyKey
        );
        const currentCycleSpotOpenProven = Boolean(
          postTickPendingSubmission
          && result.action === 'deploy'
          && result.liveOrderSubmitted
          && result.confirmationStatus === 'confirmed'
          && result.orderIntent?.idempotencyKey === postTickPendingSubmission.idempotencyKey
          && result.confirmedFill?.hasFillEvidence === true
          && result.confirmedFill.acquiredTokenAmountRaw
          && /^\d+$/.test(result.confirmedFill.acquiredTokenAmountRaw)
          && BigInt(result.confirmedFill.acquiredTokenAmountRaw) > 0n
        );
        if (
          postTickPendingSubmission
          && (currentCycleSubmissionClosureProven || currentCycleSpotOpenProven)
        ) {
          // runLiveCycle used a fresh post-submit snapshot. Keep the physical
          // pending record until the ledger/state writes below are durable,
          // but never let the stale pre-cycle snapshot veto that proof.
          resolvedPostTickSubmission = postTickPendingSubmission;
          postTickPendingSubmission = null;
          pendingSubmission = null;
          runtimeState = {
            ...runtimeState,
            mode: 'healthy' as RuntimeMode,
            circuitReason: '',
            cooldownUntil: '',
            transientAutoHealEligible: false,
            transientRecoverySuccessTicks: 0,
            updatedAt: nowIso()
          };
        } else if (postTickPendingSubmission && effectiveAccountState) {
          const postTickRecovery = await recoverPendingSubmission({
            pendingSubmission: postTickPendingSubmission,
            confirmationProvider,
            accountState: effectiveAccountState
          });

          if (postTickRecovery.clearPending) {
            const resolvedCurrentCycleSubmission = Boolean(
              result.liveOrderSubmitted
              && result.orderIntent?.idempotencyKey === postTickPendingSubmission.idempotencyKey
            );
            if (resolvedCurrentCycleSubmission) {
              // Keep the physical pending record until the matching ledger and
              // compatibility position state are durable. The logical cycle
              // may proceed as resolved, but a crash must replay this identity.
              resolvedPostTickSubmission = postTickPendingSubmission;
              postTickPendingSubmission = null;
              pendingSubmission = null;
              if (
                postTickRecovery.reason === 'pending-submission-filled' ||
                postTickRecovery.reason === 'pending-submission-confirmed'
              ) {
                runtimeState = {
                  ...runtimeState,
                  mode: 'healthy' as RuntimeMode,
                  circuitReason: '',
                  cooldownUntil: '',
                  transientAutoHealEligible: false,
                  transientRecoverySuccessTicks: 0,
                  updatedAt: nowIso()
                };
              }
            }
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
            pendingSubmission: postTickPendingSubmission !== null || resolvedPostTickSubmission !== null,
            now: nowIso()
          });
        }

        if (!(result.liveOrderSubmitted && result.action === 'dca-out')) {
          const residualSweepResult = await runResidualTokenSweepIfDue({
            strategy: options.strategy,
            executionPolicy: options.captureMode === 'mechanical-soak' || options.captureMode === 'economic-shadow'
              ? 'simulate-only'
              : 'broadcast',
            captureMode: options.captureMode,
            maxSlippageBps: options.residualSweepMaxSlippageBps ?? 100,
            maxImpactBps: options.residualSweepMaxImpactBps ?? 200,
            accountState: effectiveAccountState,
            positionLedger,
            runtimeMode: runtimeState.mode,
            runtimeReason: runtimeState.circuitReason,
            pendingSubmission: postTickPendingSubmission !== null,
            signer: cycleInput.signer ?? options.signer,
            broadcaster: cycleInput.broadcaster ?? options.broadcaster,
            confirmationProvider,
            dependencyHealth,
            residualTokenSweepStore,
            residualTokenSweepIntervalMs,
            residualTokenSweepCooldownMs,
            residualTokenSweepMinValueSol,
            nextSweepAt: nextResidualTokenSweepAt,
            preparedBroadcastStore,
            pendingSubmissionStore
          });
          dependencyHealth = residualSweepResult.dependencyHealth;
          nextResidualTokenSweepAt = residualSweepResult.nextSweepAt;
          postTickPendingSubmission = await pendingSubmissionStore.read();
          positionLedger = markResidualCleanupResolved(
            positionLedger,
            residualSweepResult.resolvedMints,
            nowIso()
          );
          if (residualSweepResult.resolvedMints.length > 0 && positionLedger) {
            await runtimeStateStore.writePositionLedger(positionLedger);
          }
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
        const runtimeAllowsNewOpens = runtimeState.mode === 'healthy'
          || runtimeState.mode === 'degraded';

        const report = buildHealthReport({
          mode: runtimeState.mode,
          allowNewOpens: false,
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
        const resultContextMint = typeof result.context?.token?.mint === 'string' ? result.context.token.mint : '';
        const resultContextPoolAddress = typeof result.context?.pool?.address === 'string' && result.context.pool.address.length > 0
          ? result.context.pool.address
          : '';
        const persistedPendingSubmission = resolvedPostTickSubmission
          ? null
          : await pendingSubmissionStore.read();
        const persistedActiveTarget = resolvePersistedActiveTarget({
          positionState,
          pendingSubmission: persistedPendingSubmission ?? pendingSubmissionBeforeCycle,
          accountState: effectiveAccountState,
          resultContextMint,
          resultContextPoolAddress,
          liveOrderSubmitted: result.liveOrderSubmitted,
          action: result.action
        });
        const persistedActiveMint = persistedActiveTarget.activeMint;
        const persistedPoolAddress = persistedActiveTarget.activePoolAddress;
        const resolvedPersistedLifecycleState = resolveLifecycleStateForPersist({
          nextLifecycleState: result.nextLifecycleState,
          previousLifecycleState: positionState?.lifecycleState,
          pendingSubmission: persistedPendingSubmission !== null,
          accountState: effectiveAccountState,
          lastAction: result.action,
          lastReason: result.reason,
          chainPositionAddress: positionState?.chainPositionAddress
            || persistedPendingSubmission?.chainPositionAddress
            || pendingSubmissionBeforeCycle?.chainPositionAddress,
          activeMint: persistedActiveMint,
          activePoolAddress: persistedPoolAddress
        });

        const persistedLifecycleState = result.fullExitClosureProven === true
          ? 'closed'
          : result.action === 'withdraw-lp' && result.submittedActionClosureProven === true
            ? 'inventory_exit_ready'
            : resolvedPersistedLifecycleState;
        const failedOpenCooldownMint = result.reason.startsWith('failed-open-cooldown:')
          ? result.reason.slice('failed-open-cooldown:'.length)
          : '';
        const positionClosed = persistedLifecycleState === 'closed';
        const fullExitClosureProven = result.fullExitClosureProven === true;
        const shouldRecordClosedMint = (
          positionClosed &&
          (isExposureReducingAction(result.action) || Boolean(positionState?.activeMint))
        ) || fullExitClosureProven || failedOpenCooldownMint.length > 0;
        const closedMint = shouldRecordClosedMint
          ? (failedOpenCooldownMint || persistedActiveMint || positionState?.activeMint || resultContextMint)
          : (positionState?.lastClosedMint ?? '');
        const closedAt = shouldRecordClosedMint ? nowIso() : (positionState?.lastClosedAt ?? '');
        const persistedActiveMintForState = (persistedLifecycleState === 'closed' || fullExitClosureProven) ? undefined : persistedActiveMint;
        const persistedActivePoolAddressForState = (persistedLifecycleState === 'closed' || fullExitClosureProven) ? undefined : persistedPoolAddress;
        const lifecycleEventNow = nowIso();
        const lifecycleEvents = buildLifecycleEventsFromResult({
          strategyId: options.strategy,
          result,
          now: lifecycleEventNow,
          fullExitClosureProven
        });
        if (lifecycleEvents.length > 0) {
          await runtimeStateStore.appendLifecycleEvents(lifecycleEvents);
        }

        positionLedger = applyLiveCycleResultToLedger({
          ledger: positionLedger,
          positionState,
          accountState: effectiveAccountState,
          pendingSubmissionBeforeCycle,
          persistedPendingSubmission,
          actionIdentity: result.actionIdentity,
          orderIntent: result.orderIntent,
          action: result.action,
          reason: result.reason,
          exitTriggerReason: result.audit?.reason,
          liveOrderSubmitted: result.liveOrderSubmitted,
          confirmationStatus: result.confirmationStatus,
          exitActionClosureProven: result.submittedActionClosureProven,
          fullExitClosureProven,
          residualCleanupStatus: residualCleanupStatusFromResult(result),
          residualCleanupValueSol: residualCleanupValueFromResult(result),
          residualCleanupAmountRaw: residualCleanupAmountRawFromResult(result),
          confirmedFill: result.confirmedFill,
          now: lifecycleEventNow
        });
        const orderAttemptRecord = buildOrderAttemptRecord({
          strategyId: options.strategy,
          actionIdentity: result.actionIdentity,
          orderIntent: result.orderIntent,
          pendingSubmission: persistedPendingSubmission ?? pendingSubmissionBeforeCycle,
          action: result.action,
          reason: result.reason,
          detail: 'failureDetail' in result && typeof result.failureDetail === 'string'
            ? result.failureDetail
            : undefined,
          liveOrderSubmitted: result.liveOrderSubmitted,
          confirmationStatus: result.confirmationStatus,
          now: nowIso()
        });
        if (orderAttemptRecord) {
          await runtimeStateStore.upsertOrderAttempt(orderAttemptRecord);
        }
        await runtimeStateStore.writePositionLedger(positionLedger);
        const projectionNow = nowIso();
        const lifecycleProjection = buildLifecycleProjection({
          ledger: positionLedger,
          pendingSubmission: persistedPendingSubmission,
          accountState: effectiveAccountState,
          maxActivePositions: options.maxActivePositions ?? 5,
          now: projectionNow
        });
        const positionLedgerSummary = summarizePositionLedger(positionLedger);
        const positionBusinessSemantics = resolvePositionBusinessSemantics({
          accountState: effectiveAccountState,
          positionState: {
            ...(positionState ?? {
              allowNewOpens: false,
              flattenOnly: runtimeState.mode === 'flatten_only',
              lastAction: result.action,
              updatedAt: nowIso()
            }),
            activeMint: persistedActiveMintForState,
            activePoolAddress: persistedActivePoolAddressForState,
            lifecycleState: persistedLifecycleState
          },
          positionLedger,
          pendingSubmission: persistedPendingSubmission,
          residualTokenSweepMinValueSol,
          maxActivePositions: options.maxActivePositions ?? 5
        });
        const closedTargetHasCapacity = positionClosed
          && !persistedPendingSubmission
          && lifecycleProjection.activeLpCount < (options.maxActivePositions ?? 5);
        const businessAllowNewOpens = runtimeAllowsNewOpens
          && (positionBusinessSemantics.canOpenNewPosition.allowed || closedTargetHasCapacity);
        report.allowNewOpens = businessAllowNewOpens;
        report.activeLpCount = lifecycleProjection.activeLpCount;
        report.chainActiveLpCount = lifecycleProjection.chainActiveLpCount;
        report.pendingOpenCount = lifecycleProjection.pendingOpenCount;
        report.reconcileRequiredCount = lifecycleProjection.reconcileRequiredCount;
        report.residualCleanupRequiredCount = lifecycleProjection.residualCleanupRequiredCount;
        report.managedLpCount = lifecycleProjection.managedLpCount;
        report.untrackedLpCount = Math.max(0, countActiveLpExposures(effectiveAccountState) - positionLedgerSummary.managedLpCount);
        report.importFailedLpCount = lifecycleProjection.importFailedLpCount;
        if (lifecycleProjection.reconcileRequiredCount > 0) {
          report.mode = report.mode === 'healthy' ? 'degraded' : report.mode;
          if (!closedTargetHasCapacity) {
            report.allowNewOpens = false;
          }
          report.circuitReason = report.circuitReason || 'lifecycle-reconcile-required';
        }
        const submittedOpenEntry = (result.action === 'add-lp' || result.action === 'deploy')
          && result.liveOrderSubmitted
          ? resolveConfirmedOpenFillEntry({
              resultFill: result.confirmedFill,
              activeMint: persistedActiveMint
            })
          : undefined;
        const retainedOpenEntry: TrustedLpEntryMetadata | undefined = !positionClosed
          && positionStateTargetMatches({
            positionState,
            activeMint: persistedActiveMint,
            activePoolAddress: persistedPoolAddress
          })
          && isTrustedEntrySolSource(positionState?.entrySolSource)
          && typeof positionState?.entrySol === 'number'
          && positionState.entrySol > 0
          ? {
              entrySol: positionState.entrySol,
              entrySolSource: positionState.entrySolSource,
              entryFillSubmissionId: positionState.entryFillSubmissionId,
              openedAt: positionState.openedAt
            }
          : undefined;
        const accountOpenEntry: TrustedLpEntryMetadata | undefined = !positionClosed
          && positionState
          ? resolveTrustedEntryFromFills({
              positionState: {
                ...positionState,
                activeMint: persistedActiveMint,
                activePoolAddress: persistedPoolAddress
              },
              fills: effectiveAccountState?.fills ?? []
            })
          : undefined;
        const persistedEntryMetadata = positionClosed
          ? undefined
          : submittedOpenEntry ?? accountOpenEntry ?? retainedOpenEntry;
        const persistedEntrySol = persistedEntryMetadata?.entrySol;
        const persistedEntrySolSource = persistedEntryMetadata?.entrySolSource;
        const persistedEntryFillSubmissionId = persistedEntryMetadata?.entryFillSubmissionId;
        const persistedOwnedTokenAmountRaw = positionClosed
          ? undefined
          : result.action === 'deploy' && result.confirmedFill?.acquiredTokenAmountRaw
            ? result.confirmedFill.acquiredTokenAmountRaw
            : positionState?.ownedTokenAmountRaw;
        const persistedOpenedAt = (result.action === 'add-lp' || result.action === 'deploy')
          && result.liveOrderSubmitted
          ? (submittedOpenEntry?.openedAt ?? nowIso())
          : positionClosed
            ? undefined
            : (persistedEntryMetadata?.openedAt ?? positionState?.openedAt);
        if (failedOpenCooldownMint.length > 0 && persistedPoolAddress.length > 0) {
          const cooldownNow = nowIso();
          await targetOpenCooldownStore.upsert({
            poolAddress: persistedPoolAddress,
            tokenMint: failedOpenCooldownMint,
            reason: result.reason,
            cooldownUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
            lastFailedAt: cooldownNow,
            updatedAt: cooldownNow
          });
        }
        await recordExitTargetOpenCooldown({
          store: targetOpenCooldownStore,
          poolAddress: persistedPoolAddress || resultContextPoolAddress || positionState?.activePoolAddress || '',
          tokenMint: persistedActiveMint || resultContextMint || positionState?.activeMint || '',
          result,
          now: nowIso()
        });

        const persistedIdentity = resolvePersistedLpIdentity({
          lifecycleState: persistedLifecycleState,
          pendingSubmission: persistedPendingSubmission ?? pendingSubmissionBeforeCycle,
          positionState,
          accountState: effectiveAccountState,
          activeMint: persistedActiveMint,
          activePoolAddress: persistedPoolAddress,
          action: result.action,
          liveOrderSubmitted: result.liveOrderSubmitted
        });
        const inferredPositionMetadata = persistedLifecycleState === 'open'
          ? inferOpenPositionMetadata({
              accountState: effectiveAccountState,
              activeMint: persistedActiveMint,
              activePoolAddress: persistedPoolAddress,
              existingEntrySol: persistedEntrySol,
              existingEntrySolSource: persistedEntrySolSource,
              existingEntryFillSubmissionId: persistedEntryFillSubmissionId,
              existingOpenedAt: persistedOpenedAt,
              fallbackOpenedAt: nowIso()
            })
          : {
              entrySol: persistedEntrySol,
              entrySolSource: persistedEntrySolSource,
              entryFillSubmissionId: persistedEntryFillSubmissionId,
              openedAt: persistedOpenedAt
            };
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
        const nextPositionState = {
          allowNewOpens: businessAllowNewOpens,
          flattenOnly: runtimeState.mode === 'flatten_only',
          lastAction: result.action,
          lastReason: result.reason,
          lastOrderIdempotencyKey: result.orderIntent?.idempotencyKey ?? positionState?.lastOrderIdempotencyKey,
          openIntentId: persistedIdentity.openIntentId,
          positionId: persistedIdentity.positionId,
          chainPositionAddress: persistedIdentity.chainPositionAddress,
          activeMint: persistedActiveMintForState,
          activePoolAddress: persistedActivePoolAddressForState,
          lifecycleState: persistedLifecycleState,
          ownedTokenAmountRaw: persistedOwnedTokenAmountRaw,
          entrySol: orphanedIdentity?.entrySol ?? inferredPositionMetadata.entrySol,
          entrySolSource: inferredPositionMetadata.entrySolSource,
          entryFillSubmissionId: inferredPositionMetadata.entryFillSubmissionId,
          openedAt: orphanedIdentity?.openedAt ?? inferredPositionMetadata.openedAt,
          valuationStatus: orphanedIdentity?.valuationStatus ?? persistedIdentity.valuationStatus,
          valuationReason: orphanedIdentity?.valuationReason ?? persistedIdentity.valuationReason,
          valuationTrust: persistedIdentity.valuationTrust,
          valuationSource: persistedIdentity.valuationSource,
          valuationCompleteness: persistedIdentity.valuationCompleteness,
          exitQuoteValueSol: persistedIdentity.exitQuoteValueSol,
          marketValueSol: persistedIdentity.marketValueSol,
          displayValueSol: persistedIdentity.displayValueSol,
          lpTotalValueSol: persistedIdentity.lpTotalValueSol,
          lastValuationAt: orphanedIdentity?.lastValuationAt ?? persistedIdentity.lastValuationAt,
          lastClosedMint: closedMint,
          lastClosedAt: closedAt,
          walletSol: effectiveAccountState?.walletSol,
          updatedAt: nowIso()
        };
        const compatibilityPositionState = selectCompatibilityPositionState({
          ledger: positionLedger,
          pendingSubmission: persistedPendingSubmission,
          prior: nextPositionState,
          advance: true,
          allowNewOpens: businessAllowNewOpens,
          flattenOnly: runtimeState.mode === 'flatten_only',
          lastAction: result.action,
          lastReason: result.reason,
          walletSol: effectiveAccountState?.walletSol,
          now: nowIso()
        });
        await runtimeStateStore.writePositionState(
          result.action === 'withdraw-lp'
          && result.submittedActionClosureProven === true
          && result.fullExitClosureProven !== true
          && compatibilityPositionState.lifecycleState === 'closed'
            ? nextPositionState
            : compatibilityPositionState
        );
        if (resolvedPostTickSubmission) {
          const stillPending = await pendingSubmissionStore.read();
          if (stillPending?.idempotencyKey === resolvedPostTickSubmission.idempotencyKey) {
            await pendingSubmissionStore.clear();
          }
          resolvedPostTickSubmission = null;
          report.pendingSubmission = false;
        }
        enqueueResolvedOpenOrderMirror({
          mirrorRuntime,
          idempotencyKey: result.orderIntent?.idempotencyKey ?? positionState?.lastOrderIdempotencyKey,
          cycleId: `${options.strategy}:${nowIso()}`,
          strategyId: options.strategy,
          openIntentId: persistedIdentity.openIntentId,
          chainPositionAddress: persistedIdentity.chainPositionAddress,
          poolAddress: persistedPoolAddress,
          tokenMint: persistedActiveMint,
          tokenSymbol: typeof result.context?.token?.symbol === 'string' ? result.context.token.symbol : '',
          createdAt: inferredPositionMetadata.openedAt ?? positionState?.openedAt,
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
          accountState: effectiveAccountState,
          chainPositionAddress: positionState?.chainPositionAddress,
          activeMint: positionState?.activeMint,
          activePoolAddress: positionState?.activePoolAddress
        });
        const persistedIdentity = resolvePersistedLpIdentity({
          lifecycleState: persistedLifecycleState,
          pendingSubmission: persistedPendingSubmission,
          positionState,
          accountState: effectiveAccountState,
          activeMint: positionState?.activeMint,
          activePoolAddress: positionState?.activePoolAddress
        });
        const positionClosed = persistedLifecycleState === 'closed';
        await runtimeStateStore.writePositionState({
          allowNewOpens: false,
          flattenOnly: runtimeState.mode === 'flatten_only',
          lastAction: 'hold',
          lastOrderIdempotencyKey: positionState?.lastOrderIdempotencyKey,
          activeMint: positionClosed ? undefined : positionState?.activeMint,
          openIntentId: persistedIdentity.openIntentId,
          positionId: persistedIdentity.positionId,
          chainPositionAddress: persistedIdentity.chainPositionAddress,
          activePoolAddress: positionClosed ? undefined : positionState?.activePoolAddress,
          lifecycleState: persistedLifecycleState,
          ownedTokenAmountRaw: positionClosed ? undefined : positionState?.ownedTokenAmountRaw,
          entrySol: positionClosed ? undefined : positionState?.entrySol,
          entrySolSource: positionClosed ? undefined : positionState?.entrySolSource,
          entryFillSubmissionId: positionClosed ? undefined : positionState?.entryFillSubmissionId,
          openedAt: positionClosed ? undefined : positionState?.openedAt,
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
