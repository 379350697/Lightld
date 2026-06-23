import { join } from 'node:path';

import { loadStrategyConfig } from '../config/loader.ts';
import type { LiveCycleOutcomeRecord } from '../evolution/index.ts';
import {
  buildCycleRunMirrorPayload,
  buildOrderMirrorPayload,
  toCycleRunEvent,
  toFillMirrorEvent,
  toIncidentMirrorEvent,
  toOrderMirrorEvent,
  toReconciliationMirrorEvent
} from '../observability/mirror-adapters.ts';
import type { MirrorEventSink, OrderBroadcastStatus } from '../observability/mirror-events.ts';
import {
  ExecutionRequestError,
  type ExecutionFailureKind
} from '../execution/error-classification.ts';
import type {
  ConfirmationFinality,
  LiveConfirmationProvider,
  LiveConfirmationResult
} from '../execution/live-confirmation-provider.ts';
import {
  TestLiveBroadcaster,
  type LiveBroadcaster,
  type LiveBroadcastResult
} from '../execution/live-broadcaster.ts';
import { trackConfirmation, type ConfirmationStatus } from '../execution/confirmation-tracker.ts';
import {
  StaticLiveQuoteProvider,
  type LiveQuoteProvider
} from '../execution/live-quote-service.ts';
import { buildOrderIntent } from '../execution/order-intent-builder.ts';
import { TestLiveSigner, type LiveOrderIntent, type LiveSigner, type SignedLiveOrderIntent } from '../execution/live-signer.ts';
import type { ExecutionPlan, SolExitQuote } from '../execution/types.ts';
import { DecisionAuditLog } from '../journals/decision-audit-log.ts';
import { LiveFillJournal } from '../journals/live-fill-journal.ts';
import { LiveIncidentJournal } from '../journals/live-incident-journal.ts';
import { LiveOrderJournal } from '../journals/live-order-journal.ts';
import { QuoteJournal } from '../journals/quote-journal.ts';
import { resolveActiveJsonlPath } from '../journals/jsonl-writer.ts';
import { evaluateLiveGuards } from '../risk/live-guards.ts';
import { evaluateLpPnl } from '../risk/lp-pnl.ts';
import type { SpendingLimitsConfig } from '../risk/spending-limits.ts';
import { SpendingLimitsStore } from '../risk/spending-limits.ts';
import { runEngineCycle } from '../strategy/engine-runner.ts';
import { buildDecisionContext, type DecisionContextInput } from './build-decision-context.ts';
import { KillSwitch } from './kill-switch.ts';
import type { LiveAccountState, LiveAccountStateProvider } from './live-account-provider.ts';
import { PendingSubmissionStore } from './pending-submission-store.ts';
import { TargetOpenCooldownStore } from './target-open-cooldown-store.ts';
import { RECENTLY_CLOSED_MINT_REOPEN_COOLDOWN_MS } from './ingest-candidate-selection.ts';
import { applyRuntimeActionPolicy } from './runtime-action-policy.ts';
import {
  classifyAction,
  type LiveAction
} from './action-semantics.ts';
import { createOpenIntentId, createPositionId } from './lp-position-record.ts';
import { buildExecutionLifecycleKey } from './execution-lifecycle-key.ts';
import {
  buildPendingTimeoutAt,
  isFullPositionExitAction,
  isResolvedConfirmation,
  resolveNextLifecycleState,
  resolveOrderIntentSide
} from './live-cycle-state.ts';
import {
  buildBlockedCycleResult,
  buildLiveSubmittedResult,
  buildTrackedPendingSubmissionSnapshot,
  buildUnknownPendingSubmissionSnapshot,
  resolveFillMirrorSide
} from './live-cycle-outcomes.ts';
import { resolveMintPositionAggregate } from './mint-position-aggregate.ts';
import {
  resolveRecoveredOrderTerminalStatus,
  runAccountReconciliationGate,
  runPendingRecoveryGate
} from './live-cycle-preflight.ts';
import { liveIncidentDedupeStore } from './incident-dedupe.ts';
import { buildIncidentDedupeKey, classifyIncidentReason } from './incident-taxonomy.ts';
import { isManageableLpPosition } from './lp-position-visibility.ts';
import { evaluateLpValuationState } from './lp-valuation.ts';
import { computeSolDepletedBins, deriveLpSolExposureStatus } from './lp-sol-exposure.ts';
import { hasAnyWalletEvidenceForPendingSubmission } from './pending-submission-wallet-evidence.ts';
import {
  classifyLpEntryFillBinding,
  isTrustedEntrySolSource,
  matchesPositionStateLifecycle,
  resolveTrustedLpEntry
} from './lp-entry-resolver.ts';
import type {
  RuntimeMode,
  PositionStateSnapshot,
  PositionLifecycleState,
  PendingSubmissionSnapshot
} from './state-types.ts';

const STRATEGY_CONFIGS = {
  'new-token-v1': 'src/config/strategies/new-token-v1.yaml',
  'large-pool-v1': 'src/config/strategies/large-pool-v1.yaml'
} as const;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);

function hasNonStableInventory(accountState: LiveAccountState | undefined) {
  return Boolean(
    accountState?.walletTokens?.some((token) => token.amount > 0 && token.mint !== SOL_MINT && !STABLE_MINTS.has(token.mint)) ||
    accountState?.walletLpPositions?.some((position) =>
      position.mint !== SOL_MINT && !STABLE_MINTS.has(position.mint) && isManageableLpPosition(position)
    ) ||
    accountState?.journalLpPositions?.some((position) =>
      position.mint !== SOL_MINT && !STABLE_MINTS.has(position.mint) && isManageableLpPosition(position)
    )
  );
}

function findLargestNonStableInventory(accountState: LiveAccountState | undefined) {
  return (accountState?.walletTokens ?? [])
    .filter((token) => token.amount > 0 && token.mint !== SOL_MINT && !STABLE_MINTS.has(token.mint))
    .sort((a, b) => b.amount - a.amount)[0];
}


export type StrategyId = keyof typeof STRATEGY_CONFIGS;

export type LiveCycleInput = {
  strategy: StrategyId;
  context?: DecisionContextInput;
  killSwitch?: KillSwitch;
  requestedPositionSol?: number;
  journalRootDir?: string;
  stateRootDir?: string;
  runtimeMode?: RuntimeMode;
  sessionPhase?: 'active' | 'flatten-only' | 'closed';
  reconciliationStatus?: 'matched' | 'balance-mismatch';
  quoteProvider?: LiveQuoteProvider;
  signer?: LiveSigner;
  broadcaster?: LiveBroadcaster;
  confirmationProvider?: LiveConfirmationProvider;
  accountProvider?: LiveAccountStateProvider;
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot;
  mirrorSink?: MirrorEventSink;
  spendingLimitsConfig?: SpendingLimitsConfig;
  evolutionSink?: {
    appendOutcome(record: LiveCycleOutcomeRecord): Promise<void>;
  };
  evolutionWatchlistCandidates?: Array<{
    tokenMint: string;
    tokenSymbol: string;
    poolAddress: string;
    sourceReason: string;
    trackedSince?: string;
  }>;
};

export type LiveCycleResult = {
  status: 'ok';
  mode: 'LIVE' | 'BLOCKED';
  action: LiveAction;
  reason: string;
  audit: { reason: string };
  context: ReturnType<typeof buildDecisionContext>;
  quoteCollected: boolean;
  quote?: SolExitQuote;
  executionPlan?: ExecutionPlan;
  liveOrderSubmitted: boolean;
  orderIntent?: LiveOrderIntent;
  broadcastResult?: LiveBroadcastResult;
  confirmationStatus?: ConfirmationStatus;
  confirmedFill?: LiveCycleConfirmedFill;
  nextLifecycleState?: PositionLifecycleState;
  aggregateLifecycleState?: PositionLifecycleState;
  failureKind?: ExecutionFailureKind;
  failureSource?: 'quote' | 'signer' | 'broadcast' | 'confirmation' | 'account' | 'recovery' | 'runtime-policy';
  journalPaths: {
    decisionAuditPath: string;
    quoteJournalPath: string;
    liveOrderPath: string;
    liveFillPath: string;
    liveIncidentPath: string;
  };
  killSwitchState: boolean;
};

type LiveCycleJournalPaths = LiveCycleResult['journalPaths'];

export type LiveCycleConfirmedFill = {
  submissionId: string;
  mint: string;
  side: LiveAction;
  filledSol: number;
  actualFilledSol?: number;
  actualWalletDeltaSol?: number;
  fillAmountSource: ActualFillAmount['fillAmountSource'];
  recordedAt: string;
  hasFillEvidence: boolean;
};

type LiveCycleJournals = {
  paths: LiveCycleJournalPaths;
  decisionAudit: DecisionAuditLog<Record<string, unknown>>;
  quotes: QuoteJournal<Record<string, unknown>>;
  orders: LiveOrderJournal<Record<string, unknown>>;
  fills: LiveFillJournal<Record<string, unknown>>;
  incidents: LiveIncidentJournal<Record<string, unknown>>;
};

type LiveFillEntry = NonNullable<LiveAccountState['fills']>[number];

type ActualFillAmount = {
  filledSol: number;
  actualFilledSol?: number;
  actualWalletDeltaSol?: number;
  preWalletSol?: number;
  postWalletSol?: number;
  fillAmountSource: 'wallet-delta' | 'requested-position-fallback';
  hasFillEvidence: boolean;
};

type LiveCycleLogContext = {
  cycleId: string;
  strategyId: StrategyId;
  startedAt: string;
  startedAtMs: number;
  contextCreatedAt: string;
  engineReason: string;
  poolAddress: string;
  tokenSymbol: string;
  tokenMint: string;
  routeExists: boolean;
  routeSlippageBps: number;
  killSwitchEngaged: boolean;
  runtimeMode: RuntimeMode;
  sessionPhase: NonNullable<LiveCycleInput['sessionPhase']>;
  liveEnabled: boolean;
};

function firstBoolean(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'boolean') {
      return value;
    }
  }

  return false;
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'number') {
      return value;
    }
  }

  return 0;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return '';
}

function roundSolLamports(value: number) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function buildEvolutionParameterSnapshot(config: Awaited<ReturnType<typeof loadStrategyConfig>>) {
  return {
    takeProfitPct: config.riskThresholds.takeProfitPct,
    stopLossPct: config.riskThresholds.stopLossPct,
    lpEnabled: config.lpConfig?.enabled ?? false,
    lpStopLossNetPnlPct: config.lpConfig?.stopLossNetPnlPct,
    lpTakeProfitNetPnlPct: config.lpConfig?.takeProfitNetPnlPct,
    lpSolDepletionExitBins: config.lpConfig?.solDepletionExitBins,
    lpMinBinStep: config.lpConfig?.minBinStep,
    lpMinVolume24hUsd: config.lpConfig?.minVolume24hUsd,
    lpMinFeeTvlRatio24h: config.lpConfig?.minFeeTvlRatio24h,
    maxHoldHours: config.live.maxHoldHours ?? 18
  };
}

function buildEvolutionExitMetrics(input: {
  context: ReturnType<typeof buildDecisionContext>;
  snapshot: Record<string, unknown>;
  requestedPositionSol: number;
  quote?: SolExitQuote;
}) {
  return {
    requestedPositionSol: input.requestedPositionSol,
    quoteOutputSol: input.quote?.outputSol,
    holdTimeMs: typeof input.snapshot.holdTimeMs === 'number' ? input.snapshot.holdTimeMs : undefined,
    lpNetPnlPct: typeof input.context.trader.lpNetPnlPct === 'number' ? input.context.trader.lpNetPnlPct : undefined,
    lpSolDepletedBins: typeof input.context.trader.lpSolDepletedBins === 'number' ? input.context.trader.lpSolDepletedBins : undefined,
    lpCurrentValueSol: typeof input.context.trader.lpCurrentValueSol === 'number' ? input.context.trader.lpCurrentValueSol : undefined,
    lpUnclaimedFeeSol: typeof input.context.trader.lpUnclaimedFeeSol === 'number' ? input.context.trader.lpUnclaimedFeeSol : undefined
  };
}

async function appendEvolutionOutcomeBestEffort(input: {
  sink: LiveCycleInput['evolutionSink'];
  logContext: LiveCycleLogContext;
  action: LiveAction;
  actualExitReason: string;
  liveOrderSubmitted: boolean;
  config: Awaited<ReturnType<typeof loadStrategyConfig>>;
  context: ReturnType<typeof buildDecisionContext>;
  snapshot: Record<string, unknown>;
  positionState?: PositionStateSnapshot;
  confirmedFill?: LiveCycleConfirmedFill;
  requestedPositionSol: number;
  quote?: SolExitQuote;
}) {
  if (!input.sink) {
    return;
  }

  try {
    const recordedAt = new Date().toISOString();
    const parameterSnapshot = buildEvolutionParameterSnapshot(input.config);
    const exitMetrics = buildEvolutionExitMetrics({
      context: input.context,
      snapshot: input.snapshot,
      requestedPositionSol: input.requestedPositionSol,
      quote: input.quote
    });
    const entrySol = resolveOutcomeEntrySol({
      positionState: input.positionState,
      confirmedFill: input.confirmedFill
    });
    const observedReturnPct = resolveObservedReturnPct({
      action: input.action,
      entrySol,
      exitMetrics
    });

    await input.sink.appendOutcome({
      cycleId: input.logContext.cycleId,
      strategyId: input.logContext.strategyId,
      recordedAt,
      tokenMint: input.logContext.tokenMint,
      tokenSymbol: input.logContext.tokenSymbol,
      poolAddress: input.logContext.poolAddress,
      runtimeMode: input.logContext.runtimeMode,
      sessionPhase: input.logContext.sessionPhase,
      positionId: resolveOutcomePositionId(input.logContext, input.positionState),
      action: input.action,
      actualExitReason: input.actualExitReason,
      openedAt: resolveOutcomeOpenedAt({
        positionState: input.positionState,
        recordedAt,
        holdTimeMs: exitMetrics.holdTimeMs
      }),
      closedAt: recordedAt,
      entrySol,
      maxObservedUpsidePct: typeof observedReturnPct === 'number' ? Math.max(observedReturnPct, 0) : undefined,
      maxObservedDrawdownPct: typeof observedReturnPct === 'number' ? Math.max(observedReturnPct * -1, 0) : undefined,
      actualExitMetricValue: resolveActualExitMetricValue(input.actualExitReason, input.action, exitMetrics),
      takeProfitPctAtEntry: parameterSnapshot.takeProfitPct,
      stopLossPctAtEntry: parameterSnapshot.stopLossPct,
      lpStopLossNetPnlPctAtEntry: parameterSnapshot.lpStopLossNetPnlPct,
      lpTakeProfitNetPnlPctAtEntry: parameterSnapshot.lpTakeProfitNetPnlPct,
      solDepletionExitBinsAtEntry: parameterSnapshot.lpSolDepletionExitBins,
      minBinStepAtEntry: parameterSnapshot.lpMinBinStep,
      liveOrderSubmitted: input.liveOrderSubmitted,
      parameterSnapshot,
      exitMetrics
    });
  } catch (error) {
    console.warn(
      `[LiveCycle] Evolution outcome persistence failed; continuing without research evidence: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function resolveOutcomePositionId(
  logContext: LiveCycleLogContext,
  positionState?: PositionStateSnapshot
) {
  if (positionState?.positionId) {
    return positionState.positionId;
  }

  if (positionState?.chainPositionAddress) {
    return positionState.chainPositionAddress;
  }

  if (positionState?.activePoolAddress && positionState.activeMint) {
    return `${positionState.activePoolAddress}:${positionState.activeMint}`;
  }

  return `${logContext.poolAddress}:${logContext.tokenMint}`;
}

function resolveOutcomeOpenedAt(input: {
  positionState?: PositionStateSnapshot;
  recordedAt: string;
  holdTimeMs?: number;
}) {
  if (typeof input.positionState?.openedAt === 'string' && input.positionState.openedAt.length > 0) {
    return input.positionState.openedAt;
  }

  if (typeof input.holdTimeMs === 'number' && Number.isFinite(input.holdTimeMs) && input.holdTimeMs > 0) {
    return new Date(Date.parse(input.recordedAt) - input.holdTimeMs).toISOString();
  }

  return input.recordedAt;
}

function resolveOutcomeEntrySol(input: {
  positionState?: PositionStateSnapshot;
  confirmedFill?: LiveCycleConfirmedFill;
}) {
  if (
    isTrustedEntrySolSource(input.positionState?.entrySolSource)
    && typeof input.positionState?.entrySol === 'number'
    && input.positionState.entrySol > 0
  ) {
    return input.positionState.entrySol;
  }

  if (
    input.confirmedFill?.side === 'add-lp'
    && input.confirmedFill.fillAmountSource === 'wallet-delta'
    && input.confirmedFill.filledSol > 0
  ) {
    return input.confirmedFill.filledSol;
  }

  return undefined;
}

function resolveActiveLpExitPositionSol(input: {
  action: LiveAction;
  positionState?: PositionStateSnapshot;
}) {
  if (
    input.action === 'withdraw-lp'
    && typeof input.positionState?.entrySol === 'number'
    && input.positionState.entrySol > 0
  ) {
    return input.positionState.entrySol;
  }

  return undefined;
}

function resolveRequestedPositionSol(input: {
  activeLpExitPositionSol?: number;
  requestedPositionSol?: number;
  quoteOutputSol: number;
}) {
  return input.activeLpExitPositionSol ?? input.requestedPositionSol ?? input.quoteOutputSol;
}

function resolveObservedReturnPct(input: {
  action: LiveAction;
  entrySol?: number;
  exitMetrics: ReturnType<typeof buildEvolutionExitMetrics>;
}) {
  if (typeof input.entrySol !== 'number' || input.entrySol <= 0) {
    return undefined;
  }

  if (typeof input.exitMetrics.quoteOutputSol === 'number') {
    return ((input.exitMetrics.quoteOutputSol - input.entrySol) / input.entrySol) * 100;
  }

  return undefined;
}

function absoluteWalletDeltaForFill(action: LiveAction, deltaSol: number) {
  if (!Number.isFinite(deltaSol) || deltaSol === 0) {
    return undefined;
  }

  if (action === 'deploy' || action === 'add-lp') {
    return deltaSol < 0 ? Math.abs(deltaSol) : undefined;
  }

  if (action === 'dca-out' || action === 'withdraw-lp' || action === 'claim-fee') {
    return deltaSol > 0 ? deltaSol : undefined;
  }

  if (action === 'rebalance-lp') {
    return Math.abs(deltaSol);
  }

  return undefined;
}

function isConfirmedConfirmation(
  status: ConfirmationStatus,
  finality?: ConfirmationFinality
) {
  return status === 'confirmed' && (finality === 'confirmed' || finality === 'finalized');
}

function matchesLpExitTarget(input: {
  position: NonNullable<LiveAccountState['walletLpPositions']>[number];
  tokenMint: string;
  poolAddress: string;
  chainPositionAddress?: string;
}) {
  if (input.chainPositionAddress) {
    return input.position.positionAddress === input.chainPositionAddress
      || input.position.chainPositionAddress === input.chainPositionAddress;
  }

  if (input.tokenMint && input.poolAddress) {
    return input.position.mint === input.tokenMint && input.position.poolAddress === input.poolAddress;
  }

  if (input.poolAddress) {
    return input.position.poolAddress === input.poolAddress;
  }

  if (input.tokenMint) {
    return input.position.mint === input.tokenMint;
  }

  return false;
}

function hasTrustedContextLpPnlInputs(input: {
  context: ReturnType<typeof buildDecisionContext>;
}) {
  const currentValueSol = typeof input.context.trader.lpCurrentValueSol === 'number'
    ? input.context.trader.lpCurrentValueSol
    : undefined;
  const valuationStatus = firstString(input.context.trader.valuationStatus, input.context.trader.lpValuationStatus);
  const valuationSource = firstString(input.context.trader.valuationSource, input.context.trader.lpValuationSource);

  return hasTrustedLpExitValue({ currentValueSol, valuationStatus, valuationSource });
}

function hasReduceRiskWalletExposure(input: {
  action: LiveAction;
  accountState?: LiveAccountState;
  tokenMint: string;
  poolAddress: string;
  chainPositionAddress?: string;
}) {
  if (!input.accountState) {
    return false;
  }

  if (input.action === 'withdraw-lp') {
    return (input.accountState.walletLpPositions ?? []).some((position) =>
      isManageableLpPosition(position) &&
      matchesLpExitTarget({
        position,
        tokenMint: input.tokenMint,
        poolAddress: input.poolAddress,
        chainPositionAddress: input.chainPositionAddress
      })
    );
  }

  if (input.action === 'dca-out') {
    return (input.accountState.walletTokens ?? []).some((token) =>
      token.mint === input.tokenMint && token.amount > 0
    );
  }

  return false;
}

function hasPositiveWalletTokenBalance(input: {
  accountState?: LiveAccountState;
  tokenMint: string;
}) {
  if (!input.accountState?.walletTokens || !input.tokenMint) {
    return undefined;
  }

  return input.accountState.walletTokens.some((token) =>
    token.mint === input.tokenMint && token.amount > 0
  );
}

async function resolveActualFillAmount(input: {
  action: LiveAction;
  beforeAccountState?: LiveAccountState;
  accountProvider?: LiveAccountStateProvider;
  fallbackSol: number;
}): Promise<ActualFillAmount> {
  const fallback: ActualFillAmount = {
    filledSol: input.fallbackSol,
    fillAmountSource: 'requested-position-fallback',
    hasFillEvidence: false
  };

  if (!input.accountProvider || typeof input.beforeAccountState?.walletSol !== 'number') {
    return fallback;
  }

  try {
    const afterAccountState = await input.accountProvider.readState();
    if (typeof afterAccountState.walletSol !== 'number' || !Number.isFinite(afterAccountState.walletSol)) {
      return fallback;
    }

    const actualWalletDeltaSol = roundSolLamports(afterAccountState.walletSol - input.beforeAccountState.walletSol);
    const actualFilledSol = absoluteWalletDeltaForFill(input.action, actualWalletDeltaSol);

    if (typeof actualFilledSol !== 'number' || actualFilledSol <= 0) {
      return {
        ...fallback,
        actualWalletDeltaSol,
        preWalletSol: roundSolLamports(input.beforeAccountState.walletSol),
        postWalletSol: roundSolLamports(afterAccountState.walletSol)
      };
    }

    return {
      filledSol: roundSolLamports(actualFilledSol),
      actualFilledSol: roundSolLamports(actualFilledSol),
      actualWalletDeltaSol,
      preWalletSol: roundSolLamports(input.beforeAccountState.walletSol),
      postWalletSol: roundSolLamports(afterAccountState.walletSol),
      fillAmountSource: 'wallet-delta' as const,
      hasFillEvidence: true
    };
  } catch {
    return fallback;
  }
}
function resolveActualExitMetricValue(
  actualExitReason: string,
  action: LiveAction,
  exitMetrics: ReturnType<typeof buildEvolutionExitMetrics>
) {
  if (
    (actualExitReason.includes('sol-depletion') || actualExitReason.includes('sol-nearly-depleted')) &&
    typeof exitMetrics.lpSolDepletedBins === 'number'
  ) {
    return exitMetrics.lpSolDepletedBins;
  }

  if (
    (actualExitReason.includes('stop-loss') || action === 'withdraw-lp' || action === 'claim-fee' || action === 'rebalance-lp')
    && typeof exitMetrics.lpNetPnlPct === 'number'
  ) {
    return exitMetrics.lpNetPnlPct;
  }

  if (typeof exitMetrics.quoteOutputSol === 'number') {
    return exitMetrics.quoteOutputSol;
  }

  return undefined;
}

function getHoldTimeMs(input: {
  fills: LiveFillEntry[];
  mint: string;
  nowMs: number;
  positionState?: PositionStateSnapshot;
}): number {
  if (!input.mint) {
    return 0;
  }

  if (
    input.positionState?.lifecycleState === 'open'
    && input.positionState.activeMint === input.mint
    && typeof input.positionState.openedAt === 'string'
    && input.positionState.openedAt.length > 0
  ) {
    return Math.max(0, input.nowMs - Date.parse(input.positionState.openedAt));
  }

  const mintFills = input.fills
    .filter((fill) => fill.mint === input.mint && (fill.side === 'buy' || fill.side === 'add-lp') && fill.recordedAt)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));

  if (mintFills.length > 0) {
    return Math.max(0, input.nowMs - Date.parse(mintFills[0].recordedAt));
  }

  return 0;
}

function resolvePendingConfirmationStatus(input: {
  pendingSubmission: Awaited<ReturnType<PendingSubmissionStore['read']>>;
  positionState?: PositionStateSnapshot;
  mint: string;
}) {
  if (input.pendingSubmission?.confirmationStatus) {
    return input.pendingSubmission.confirmationStatus;
  }

  if (
    input.positionState?.lifecycleState === 'open'
    && input.positionState.activeMint === input.mint
  ) {
    return 'confirmed' as const;
  }

  return undefined;
}

function dedupeLiveFills(fills: LiveFillEntry[]) {
  const deduped = new Map<string, LiveFillEntry>();

  for (const fill of fills) {
    const key = [
      fill.submissionId ?? '',
      fill.confirmationSignature ?? '',
      fill.mint,
      fill.side,
      String(fill.amount),
      fill.recordedAt
    ].join(':');

    if (!deduped.has(key)) {
      deduped.set(key, fill);
    }
  }

  return Array.from(deduped.values());
}

function mergeHistoricalFills(accountState: LiveAccountState | undefined, journalFills: Record<string, unknown>[]): LiveFillEntry[] {
  const normalizedJournalFills = journalFills.flatMap((entry) => {
    const mint = typeof entry.mint === 'string'
      ? entry.mint
      : typeof entry.tokenMint === 'string'
        ? entry.tokenMint
        : '';
    const symbol = typeof entry.symbol === 'string'
      ? entry.symbol
      : typeof entry.tokenSymbol === 'string'
        ? entry.tokenSymbol
        : undefined;
    const side = entry.side;
    const amount = typeof entry.amount === 'number'
      ? entry.amount
      : typeof entry.filledSol === 'number'
        ? entry.filledSol
        : undefined;
    const actualFilledSol = typeof entry.actualFilledSol === 'number' ? entry.actualFilledSol : undefined;
    const actualWalletDeltaSol = typeof entry.actualWalletDeltaSol === 'number' ? entry.actualWalletDeltaSol : undefined;
    const hasFillEvidence = typeof entry.hasFillEvidence === 'boolean' ? entry.hasFillEvidence : undefined;
    const preWalletSol = typeof entry.preWalletSol === 'number' ? entry.preWalletSol : undefined;
    const postWalletSol = typeof entry.postWalletSol === 'number' ? entry.postWalletSol : undefined;
    const fillAmountSource = entry.fillAmountSource === 'wallet-delta'
      || entry.fillAmountSource === 'chain-reconstructed'
      || entry.fillAmountSource === 'requested-position-fallback'
      ? entry.fillAmountSource
      : undefined;
    const confirmationStatus = typeof entry.confirmationStatus === 'string' ? entry.confirmationStatus : '';
    const status = typeof entry.status === 'string' ? entry.status : '';
    const recordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt : '';

    if (
      confirmationStatus === 'submitted'
      || confirmationStatus === 'unknown'
      || status === 'submitted'
    ) {
      return [];
    }

    if (
      !mint ||
      !recordedAt ||
      typeof amount !== 'number' ||
      amount <= 0 ||
      !(
        side === 'buy' ||
        side === 'sell' ||
        side === 'add-lp' ||
        side === 'withdraw-lp' ||
        side === 'claim-fee' ||
        side === 'rebalance-lp'
      )
    ) {
      return [];
    }

    return [{
      submissionId: typeof entry.submissionId === 'string' ? entry.submissionId : undefined,
      confirmationSignature: typeof entry.confirmationSignature === 'string' ? entry.confirmationSignature : undefined,
      openIntentId: typeof entry.openIntentId === 'string' ? entry.openIntentId : undefined,
      positionId: typeof entry.positionId === 'string' ? entry.positionId : undefined,
      chainPositionAddress: typeof entry.chainPositionAddress === 'string'
        ? entry.chainPositionAddress
        : typeof entry.positionAddress === 'string'
          ? entry.positionAddress
          : undefined,
      mint,
      symbol,
      side,
      amount,
      actualFilledSol,
      actualWalletDeltaSol,
      fillAmountSource,
      hasFillEvidence,
      preWalletSol,
      postWalletSol,
      recordedAt
    } satisfies LiveFillEntry];
  });

  return dedupeLiveFills([
    ...(accountState?.fills ?? []),
    ...normalizedJournalFills
  ]).sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
}

function buildLpExitSnapshotFromPosition(input: {
  position: NonNullable<LiveAccountState['walletLpPositions']>[number];
  holdTimeMs: number;
  solDepletionExitBins?: number;
}) {
  const observedAt = new Date().toISOString();
  const lpSolDepletedBins = typeof input.position.solDepletedBins === 'number'
    ? input.position.solDepletedBins
    : computeSolDepletedBins({
      lowerBinId: input.position.lowerBinId,
      upperBinId: input.position.upperBinId,
      activeBinId: input.position.activeBinId,
      solSide: input.position.solSide
    });
  const lpSolExposureStatus = deriveLpSolExposureStatus({
    solDepletedBins: lpSolDepletedBins,
    binCount: input.position.binCount,
    solDepletionExitBins: input.solDepletionExitBins,
    withdrawSolAmount: input.position.withdrawSolAmount,
    withdrawTokenValueSol: input.position.withdrawTokenValueSol
  });
  const valuation = typeof input.position.valuationStatus === 'string'
    ? {
      valuationStatus: input.position.valuationStatus,
      valuationReason: input.position.valuationReason ?? '',
      lastValuationAt: input.position.lastValuationAt ?? observedAt
    }
    : evaluateLpValuationState({
      currentValueSol: input.position.currentValueSol,
      unclaimedFeeSol: input.position.unclaimedFeeSol,
      hasClaimableFees: input.position.hasClaimableFees,
      observedAt
    });

  return {
    hasSolRoute: true,
    liquidityUsd: 1,
    inSession: true,
    hasInventory: true,
    hasLpPosition: true,
    lpCurrentValueSol: input.position.currentValueSol,
    lpUnclaimedFeeSol: input.position.unclaimedFeeSol,
    lpSolDepletedBins,
    lpSolExposureStatus,
    lpActiveBinStatus: typeof input.position.activeBinId === 'number'
      && typeof input.position.lowerBinId === 'number'
      && typeof input.position.upperBinId === 'number'
      ? (input.position.activeBinId >= input.position.lowerBinId && input.position.activeBinId <= input.position.upperBinId ? 'in-range' : 'out-of-range')
      : undefined,
    valuationStatus: valuation.valuationStatus,
    valuationReason: valuation.valuationReason,
    valuationSource: input.position.valuationSource,
    holdTimeMs: input.holdTimeMs,
    pendingConfirmationStatus: 'confirmed' as const,
    lifecycleState: 'open'
  };
}

function resolveLifecycleOpenFill(input: {
  fills: LiveFillEntry[];
  position: NonNullable<LiveAccountState['walletLpPositions']>[number];
  positionState?: PositionStateSnapshot;
}) {
  const entryFills = input.fills
    .filter((fill) => (fill.side === 'add-lp' || fill.side === 'buy') && fill.amount > 0);

  const byChainAddress = entryFills
    .filter((fill) => fill.chainPositionAddress === input.position.positionAddress)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))[0];

  if (byChainAddress) {
    return byChainAddress;
  }

  if (!input.positionState) {
    return undefined;
  }

  return entryFills
    .filter((fill) => classifyLpEntryFillBinding({
      fill,
      positionState: input.positionState!
    }) !== 'none')
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt))[0];
}

function resolvePositionStateOpenFill(input: {
  fills: LiveFillEntry[];
  positionState?: PositionStateSnapshot;
}) {
  const positionState = input.positionState;
  if (!positionState) {
    return undefined;
  }

  return input.fills
    .filter((fill) => classifyLpEntryFillBinding({ fill, positionState }) !== 'none')
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt))[0];
}

function dedupeActiveLpPositions(accountState?: LiveAccountState) {
  const deduped = new Map<string, NonNullable<LiveAccountState['walletLpPositions']>[number]>();

  for (const position of [
    ...(accountState?.walletLpPositions ?? []),
    ...(accountState?.journalLpPositions ?? [])
  ]) {
    if (!isManageableLpPosition(position)) {
      continue;
    }

    const key = position.positionAddress || `${position.poolAddress}:${position.mint}`;
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, position);
      continue;
    }

    const existingValue = typeof existing.currentValueSol === 'number' ? existing.currentValueSol : -1;
    const nextValue = typeof position.currentValueSol === 'number' ? position.currentValueSol : -1;

    if (nextValue > existingValue) {
      deduped.set(key, position);
    }
  }

  return Array.from(deduped.values());
}

function getLpExitPriority(action: 'withdraw-lp' | 'claim-fee' | 'rebalance-lp', reason?: string) {
  if (action === 'withdraw-lp') {
    if (reason === 'lp-stop-loss') {
      return 600;
    }

    if (reason === 'lp-max-impermanent-loss') {
      return 550;
    }

    if (reason === 'max-hold-with-lp-position') {
      return 500;
    }

    if (reason === 'lp-sol-nearly-depleted') {
      return 450;
    }

    if (reason === 'lp-take-profit') {
      return 400;
    }

    return 350;
  }

  if (action === 'claim-fee') {
    return 200;
  }

  return 100;
}

function hasTrustedLpExitValue(input: {
  currentValueSol?: unknown;
  valuationStatus?: unknown;
  valuationSource?: unknown;
}) {
  const valuationSource = typeof input.valuationSource === 'string' ? input.valuationSource : '';
  const trustedValuationSource = valuationSource === 'meteora-withdraw-simulation'
    || valuationSource.includes('jupiter-sell-quote')
    || valuationSource.includes('dlmm-active-bin-price-fallback');

  return input.valuationStatus === 'ready'
    && typeof input.currentValueSol === 'number'
    && Number.isFinite(input.currentValueSol)
    && input.currentValueSol >= 0
    && valuationSource.includes('withdraw-simulation')
    && trustedValuationSource;
}

function computeTrustedLpNetPnlPct(input: {
  entrySol?: number;
  currentValueSol?: number;
  unclaimedFeeSol?: number;
  valuationSource?: string;
  config: Awaited<ReturnType<typeof loadStrategyConfig>>;
}) {
  if (
    typeof input.entrySol !== 'number'
    || input.entrySol <= 0
    || typeof input.currentValueSol !== 'number'
    || !Number.isFinite(input.currentValueSol)
  ) {
    return undefined;
  }

  const currentValueIncludesFees = typeof input.valuationSource === 'string'
    && input.valuationSource.includes('withdraw-simulation');
  const accumulatedFeesSol = currentValueIncludesFees
    ? 0
    : (typeof input.unclaimedFeeSol === 'number' ? input.unclaimedFeeSol : 0);

  return evaluateLpPnl(input.entrySol, input.currentValueSol, accumulatedFeesSol, {
    stopLossNetPnlPct: input.config.lpConfig?.stopLossNetPnlPct ?? 20,
    takeProfitNetPnlPct: input.config.lpConfig?.takeProfitNetPnlPct ?? 30
  }).unrealizedPct;
}
function selectTriggeredLpExit(input: {
  accountState?: LiveAccountState;
  config: Awaited<ReturnType<typeof loadStrategyConfig>>;
  nowMs: number;
  fills: LiveFillEntry[];
  positionState?: PositionStateSnapshot;
}) {
  const triggered: Array<{
    position: NonNullable<LiveAccountState['walletLpPositions']>[number];
    decision: ReturnType<typeof runEngineCycle>;
    entrySol?: number;
    snapshot: Record<string, unknown>;
    holdTimeMs: number;
    priority: number;
  }> = [];

  for (const position of dedupeActiveLpPositions(input.accountState)) {
    const mint = position.mint;
    if (!mint) {
      continue;
    }

    const lifecycleBound = matchesPositionStateLifecycle(position, input.positionState);
    const openFill = resolveLifecycleOpenFill({
      fills: input.fills,
      position,
      positionState: input.positionState
    });
    const trustedEntry = resolveTrustedLpEntry({
      positionState: input.positionState,
      openFill,
      lifecycleBound
    });
    const entrySol = trustedEntry?.entrySol;
    const currentValueSol = typeof position.currentValueSol === 'number' ? position.currentValueSol : undefined;
    const unclaimedFeeSol = typeof position.unclaimedFeeSol === 'number' ? position.unclaimedFeeSol : 0;
    const lpNetPnlPct = hasTrustedLpExitValue({
      currentValueSol,
      valuationStatus: position.valuationStatus,
      valuationSource: position.valuationSource
    })
      ? computeTrustedLpNetPnlPct({
        entrySol: trustedEntry?.entrySol,
        currentValueSol,
        unclaimedFeeSol,
        valuationSource: position.valuationSource,
        config: input.config
      })
      : undefined;
    const holdTimeMs = lifecycleBound && input.positionState?.openedAt
      ? Math.max(0, input.nowMs - Date.parse(input.positionState.openedAt))
      : openFill?.recordedAt
        ? Math.max(0, input.nowMs - Date.parse(openFill.recordedAt))
        : 0;
    const snapshot: any = buildLpExitSnapshotFromPosition({
      position,
      holdTimeMs,
      solDepletionExitBins: input.config.lpConfig?.solDepletionExitBins
    });
    if (typeof lpNetPnlPct === 'number') {
      snapshot.lpNetPnlPct = lpNetPnlPct;
    }

    const decision = runEngineCycle({
      engine: 'new-token',
      snapshot,
      config: {
        maxHoldHours: input.config.live.maxHoldHours ?? 18,
        requireSolRoute: true,
        minLiquidityUsd: 0,
        lpEnabled: input.config.lpConfig?.enabled ?? false,
        lpStopLossNetPnlPct: input.config.lpConfig?.stopLossNetPnlPct,
        lpTakeProfitNetPnlPct: input.config.lpConfig?.takeProfitNetPnlPct,
        lpMinHoldMinutesBeforeTakeProfit: 5,
        lpSolDepletionExitBins: input.config.lpConfig?.solDepletionExitBins,
        lpClaimFeeThresholdUsd: input.config.lpConfig?.claimFeeThresholdUsd,
        lpRebalanceOnOutOfRange: input.config.lpConfig?.rebalanceOnOutOfRange ?? false,
        lpMaxImpermanentLossPct: input.config.lpConfig?.maxImpermanentLossPct
      }
    });

    if (decision.action === 'withdraw-lp' || decision.action === 'claim-fee' || decision.action === 'rebalance-lp') {
      triggered.push({
        position,
        decision,
        entrySol,
        snapshot,
        holdTimeMs,
        priority: getLpExitPriority(decision.action, decision.audit.reason)
      });
    }
  }

  triggered.sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }

    if (right.holdTimeMs !== left.holdTimeMs) {
      return right.holdTimeMs - left.holdTimeMs;
    }

    const rightBins = typeof right.position.solDepletedBins === 'number' ? right.position.solDepletedBins : -1;
    const leftBins = typeof left.position.solDepletedBins === 'number' ? left.position.solDepletedBins : -1;
    return rightBins - leftBins;
  });

  return triggered[0] ?? null;
}

function buildEngineSnapshot(
  poolClass: 'new-token' | 'large-pool',
  context: ReturnType<typeof buildDecisionContext>
) {
  const shared = {
    hasSolRoute: firstBoolean(
      context.route.hasSolRoute,
      context.pool.hasSolRoute,
      context.token.hasSolRoute
    ),
    liquidityUsd: firstNumber(context.pool.liquidityUsd, context.token.liquidityUsd),
    poolCreatedAt: firstString(context.pool.capturedAt, context.pool.poolCreatedAt, context.token.capturedAt)
  };

  if (poolClass === 'new-token') {
    return {
      ...shared,
      inSession: firstBoolean(context.token.inSession, context.trader.inSession),
      hasInventory: firstBoolean(context.trader.hasInventory, context.pool.hasInventory),
      unrealizedPct: typeof context.trader.unrealizedPct === 'number' ? context.trader.unrealizedPct : undefined,
      hasLpPosition: firstBoolean(context.trader.hasLpPosition),
      lpNetPnlPct: hasTrustedContextLpPnlInputs({ context }) && typeof context.trader.lpNetPnlPct === 'number'
        ? context.trader.lpNetPnlPct
        : undefined,
      lpCurrentValueSol: typeof context.trader.lpCurrentValueSol === 'number' ? context.trader.lpCurrentValueSol : undefined,
      lpUnclaimedFeeSol: typeof context.trader.lpUnclaimedFeeSol === 'number' ? context.trader.lpUnclaimedFeeSol : undefined,
      lpSolDepletedBins: typeof context.trader.lpSolDepletedBins === 'number' ? context.trader.lpSolDepletedBins : undefined,
      lpSolExposureStatus: typeof context.trader.lpSolExposureStatus === 'string' ? context.trader.lpSolExposureStatus : undefined,
      lpImpermanentLossPct: typeof context.trader.lpImpermanentLossPct === 'number' ? context.trader.lpImpermanentLossPct : undefined,
      lpUnclaimedFeeUsd: typeof context.trader.lpUnclaimedFeeUsd === 'number' ? context.trader.lpUnclaimedFeeUsd : undefined,
      lpActiveBinStatus: context.trader.lpActiveBinStatus as any,
      valuationStatus: firstString(context.trader.valuationStatus, context.trader.lpValuationStatus) as any,
      valuationReason: firstString(context.trader.valuationReason, context.trader.lpValuationReason),
      valuationSource: firstString(context.trader.valuationSource, context.trader.lpValuationSource),
      lifecycleState: typeof context.trader.lifecycleState === 'string' ? context.trader.lifecycleState : undefined
    };
  }

  return {
    ...shared
  };
}

function maybePopulateLpNetPnlPct(input: {
  context: ReturnType<typeof buildDecisionContext>;
  positionState?: PositionStateSnapshot;
  config: Awaited<ReturnType<typeof loadStrategyConfig>>;
  requestedPositionSol?: number;
  fills: LiveFillEntry[];
}) {
  const currentValueSol = typeof input.context.trader.lpCurrentValueSol === 'number'
    ? input.context.trader.lpCurrentValueSol
    : undefined;
  const valuationStatus = firstString(input.context.trader.valuationStatus, input.context.trader.lpValuationStatus);
  const valuationSource = firstString(input.context.trader.valuationSource, input.context.trader.lpValuationSource);

  if (!hasTrustedLpExitValue({ currentValueSol, valuationStatus, valuationSource })) {
    delete input.context.trader.lpNetPnlPct;
    return;
  }

  const openFill = resolvePositionStateOpenFill({
    fills: input.fills,
    positionState: input.positionState
  });
  const trustedEntry = resolveTrustedLpEntry({
    positionState: input.positionState,
    openFill,
    lifecycleBound: input.positionState?.lifecycleState === 'open'
  });
  const lpNetPnlPct = computeTrustedLpNetPnlPct({
    entrySol: trustedEntry?.entrySol,
    currentValueSol,
    unclaimedFeeSol: typeof input.context.trader.lpUnclaimedFeeSol === 'number'
      ? input.context.trader.lpUnclaimedFeeSol
      : undefined,
    valuationSource,
    config: input.config
  });

  if (typeof lpNetPnlPct === 'number') {
    input.context.trader.lpNetPnlPct = lpNetPnlPct;
  } else {
    delete input.context.trader.lpNetPnlPct;
  }
}

function createJournalPaths(strategyId: StrategyId, journalRootDir = join('tmp', 'journals')): LiveCycleJournalPaths {
  const now = new Date();

  return {
    decisionAuditPath: resolveActiveJsonlPath(join(journalRootDir, `${strategyId}-decision-audit.jsonl`), now),
    quoteJournalPath: resolveActiveJsonlPath(join(journalRootDir, `${strategyId}-quotes.jsonl`), now),
    liveOrderPath: resolveActiveJsonlPath(join(journalRootDir, `${strategyId}-live-orders.jsonl`), now),
    liveFillPath: resolveActiveJsonlPath(join(journalRootDir, `${strategyId}-live-fills.jsonl`), now),
    liveIncidentPath: resolveActiveJsonlPath(join(journalRootDir, `${strategyId}-live-incidents.jsonl`), now)
  };
}

function createJournals(strategyId: StrategyId, journalRootDir?: string): LiveCycleJournals {
  const rootDir = journalRootDir ?? join('tmp', 'journals');
  const paths = createJournalPaths(strategyId, rootDir);
  const now = () => new Date();

  return {
    paths,
    decisionAudit: new DecisionAuditLog(join(rootDir, `${strategyId}-decision-audit.jsonl`), {
      rotateDaily: true,
      retentionDays: 14,
      now
    }),
    quotes: new QuoteJournal(join(rootDir, `${strategyId}-quotes.jsonl`), {
      rotateDaily: true,
      retentionDays: 7,
      now
    }),
    orders: new LiveOrderJournal(join(rootDir, `${strategyId}-live-orders.jsonl`), {
      rotateDaily: true,
      retentionDays: 90,
      now
    }),
    fills: new LiveFillJournal(join(rootDir, `${strategyId}-live-fills.jsonl`), {
      rotateDaily: true,
      retentionDays: 90,
      now
    }),
    incidents: new LiveIncidentJournal(join(rootDir, `${strategyId}-live-incidents.jsonl`), {
      rotateDaily: true,
      retentionDays: 30,
      now
    })
  };
}

function resolveActionIdentity(input: {
  action: LiveAction;
  positionState?: PositionStateSnapshot;
  pendingSubmission: Awaited<ReturnType<PendingSubmissionStore['read']>>;
  poolAddress: string;
  tokenMint: string;
  chainPositionAddress?: string;
}) {
  const chainPositionAddress = firstString(
    input.chainPositionAddress,
    input.positionState?.chainPositionAddress,
    input.pendingSubmission?.chainPositionAddress
  ) || undefined;
  const positionId = firstString(
    input.positionState?.positionId,
    input.pendingSubmission?.positionId
  ) || undefined;
  const openIntentId = firstString(
    input.positionState?.openIntentId,
    input.pendingSubmission?.openIntentId
  ) || undefined;

  if (input.action === 'add-lp') {
    return {
      openIntentId: openIntentId ?? createOpenIntentId(),
      positionId: positionId ?? createPositionId({
        chainPositionAddress,
        poolAddress: input.poolAddress,
        tokenMint: input.tokenMint
      }),
      chainPositionAddress
    };
  }

  return {
    openIntentId,
    positionId: positionId ?? (input.poolAddress || input.tokenMint
      ? createPositionId({
          chainPositionAddress,
          poolAddress: input.poolAddress,
          tokenMint: input.tokenMint
        })
      : undefined),
    chainPositionAddress
  };
}
function resolveStateBoundOpenTarget(input: {
  positionState?: PositionStateSnapshot;
  tokenMint: string;
}) {
  const positionState = input.positionState;
  if (positionState?.lifecycleState !== 'open') {
    return null;
  }

  const activePoolAddress = firstString(positionState.activePoolAddress);
  if (!activePoolAddress) {
    return null;
  }

  const activeMint = firstString(positionState.activeMint);
  if (activeMint && input.tokenMint && activeMint !== input.tokenMint) {
    return null;
  }

  return {
    activeMint,
    activePoolAddress
  };
}

function resolveStateRootDir(strategyId: StrategyId, stateRootDir?: string) {
  return stateRootDir ?? join('state', strategyId);
}

function buildCycleId(strategyId: StrategyId, startedAt: string) {
  return `${strategyId}:${startedAt}`;
}

function durationMs(logContext: LiveCycleLogContext) {
  return Math.max(0, Date.now() - logContext.startedAtMs);
}
function toConfirmationResult(
  result: LiveConfirmationResult
): {
  status: ConfirmationStatus;
  submissionId?: string;
  reason?: string;
  finality: ConfirmationFinality;
  checkedAt: string;
} {
  return {
    status: result.status,
    submissionId: result.submissionId,
    reason: result.reason,
    finality: result.finality,
    checkedAt: result.checkedAt
  };
}

function emitMirrorEvent(mirrorSink: MirrorEventSink | undefined, eventFactory: () => void) {
  try {
    if (mirrorSink) {
      eventFactory();
    }
  } catch {
    // Mirror failures must never block the trade path.
  }
}

function getBroadcastSubmissionId(result: LiveBroadcastResult | undefined) {
  if (!result || result.status !== 'submitted') {
    return undefined;
  }

  return result.submissionId;
}

function getBroadcastTrackedSubmissions(result: LiveBroadcastResult | undefined) {
  if (!result || result.status !== 'submitted') {
    return [];
  }

  const submissionIds = result.submissionIds?.filter((submissionId) => submissionId.length > 0) ?? [];
  const confirmationSignatures = result.confirmationSignatures ?? [];

  if (submissionIds.length > 0) {
    return submissionIds.map((submissionId, index) => ({
      submissionId,
      confirmationSignature:
        confirmationSignatures[index] ??
        (submissionId === result.submissionId ? result.confirmationSignature : undefined)
    }));
  }

  return [{
    submissionId: result.submissionId,
    confirmationSignature: result.confirmationSignature
  }];
}

function buildMirrorLifecycleKey(input: {
  tokenMint: string;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
}) {
  return buildExecutionLifecycleKey(input);
}

function emitRecoveredOrderState(input: {
  mirrorSink?: MirrorEventSink;
  pendingSubmission: PendingSubmissionSnapshot;
  recoveryReason: 'pending-submission-confirmed' | 'pending-submission-filled' | 'pending-submission-failed';
  cycleId: string;
  strategyId: StrategyId;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  updatedAt: string;
}) {
  if (!input.pendingSubmission.idempotencyKey) {
    return;
  }

  const terminalStatus = resolveRecoveredOrderTerminalStatus(input.recoveryReason);
  if (!terminalStatus) {
    return;
  }

  const confirmationStatus = terminalStatus.confirmationStatus;
  const finality = terminalStatus.finality === 'confirmed'
    ? (input.pendingSubmission.finality === 'finalized' ? 'finalized' : 'confirmed')
    : terminalStatus.finality;

  emitMirrorEvent(input.mirrorSink, () => {
    input.mirrorSink!.enqueue(toOrderMirrorEvent(buildOrderMirrorPayload({
      lifecycleKey: buildMirrorLifecycleKey({
        tokenMint: input.pendingSubmission.tokenMint ?? input.tokenMint,
        openIntentId: input.pendingSubmission.openIntentId,
        positionId: input.pendingSubmission.positionId,
        chainPositionAddress: input.pendingSubmission.chainPositionAddress
      }),
      idempotencyKey: input.pendingSubmission.idempotencyKey,
      cycleId: input.cycleId,
      strategyId: input.strategyId,
      submissionId: input.pendingSubmission.submissionId,
      openIntentId: input.pendingSubmission.openIntentId,
      positionId: input.pendingSubmission.positionId,
      chainPositionAddress: input.pendingSubmission.chainPositionAddress,
      confirmationSignature: input.pendingSubmission.confirmationSignature,
      poolAddress: input.pendingSubmission.poolAddress ?? input.poolAddress,
      tokenMint: input.pendingSubmission.tokenMint ?? input.tokenMint,
      tokenSymbol: input.pendingSubmission.tokenSymbol ?? input.tokenSymbol,
      action: input.pendingSubmission.orderAction ?? 'unknown',
      requestedPositionSol: 0,
      quotedOutputSol: 0,
      broadcastStatus: terminalStatus.broadcastStatus,
      confirmationStatus,
      finality,
      createdAt: input.pendingSubmission.createdAt,
      updatedAt: input.updatedAt
    })));
  });
}

function aggregateTrackedConfirmations(results: Array<{
  status: ConfirmationStatus;
  submissionId?: string;
  reason?: string;
  finality: ConfirmationFinality;
  checkedAt: string;
}>) {
  const allConfirmed = results.every((result) =>
    result.status === 'confirmed' && (result.finality === 'confirmed' || result.finality === 'finalized')
  );
  const allFailed = results.every((result) =>
    result.status === 'failed' || result.finality === 'failed'
  );
  const anyFailed = results.some((result) =>
    result.status === 'failed' || result.finality === 'failed'
  );
  const latestCheckedAt = results.reduce((latest, result) =>
    result.checkedAt > latest ? result.checkedAt : latest,
  results[0]?.checkedAt ?? new Date().toISOString());
  const latestReason = results.find((result) => result.reason)?.reason;

  if (allConfirmed) {
    return {
      confirmation: {
        status: 'confirmed' as const,
        submissionId: results[results.length - 1]?.submissionId,
        reason: latestReason
      },
      finality: results.every((result) => result.finality === 'finalized') ? ('finalized' as const) : ('confirmed' as const),
      checkedAt: latestCheckedAt
    };
  }

  if (allFailed) {
    return {
      confirmation: {
        status: 'failed' as const,
        submissionId: results[results.length - 1]?.submissionId,
        reason: latestReason
      },
      finality: 'failed' as const,
      checkedAt: latestCheckedAt
    };
  }

  if (anyFailed) {
    return {
      confirmation: {
        status: 'unknown' as const,
        submissionId: results[results.length - 1]?.submissionId,
        reason: 'pending-submission-partial-failure'
      },
      finality: 'unknown' as const,
      checkedAt: latestCheckedAt
    };
  }

  return {
    confirmation: {
      status: 'submitted' as const,
      submissionId: results[results.length - 1]?.submissionId,
      reason: latestReason
    },
    finality: 'unknown' as const,
    checkedAt: latestCheckedAt
  };
}

async function appendDecision(
  journals: LiveCycleJournals,
  logContext: LiveCycleLogContext,
  entry: {
    stage:
      | 'engine'
      | 'live-config'
      | 'reconciliation'
      | 'guards'
      | 'signer'
      | 'broadcast'
      | 'recovery'
      | 'runtime-policy';
    mode: LiveCycleResult['mode'];
    action: LiveCycleResult['action'];
    reason: string;
    requestedPositionSol?: number;
    quote?: SolExitQuote;
    confirmationStatus?: ConfirmationStatus;
    submissionId?: string;
    reconciliationDeltaSol?: number;
    liveOrderSubmitted: boolean;
  }
) {
  await journals.decisionAudit.append({
    cycleId: logContext.cycleId,
    strategyId: logContext.strategyId,
    stage: entry.stage,
    mode: entry.mode,
    action: entry.action,
    reason: entry.reason,
    engineReason: logContext.engineReason,
    poolAddress: logContext.poolAddress,
    tokenSymbol: logContext.tokenSymbol,
    tokenMint: logContext.tokenMint,
    requestedPositionSol: entry.requestedPositionSol,
    routeExists: entry.quote?.routeExists ?? logContext.routeExists,
    routeSlippageBps: entry.quote?.slippageBps ?? logContext.routeSlippageBps,
    quoteOutputSol: entry.quote?.outputSol,
    quoteStale: entry.quote?.stale,
    confirmationStatus: entry.confirmationStatus,
    submissionId: entry.submissionId,
    reconciliationDeltaSol: entry.reconciliationDeltaSol,
    contextCreatedAt: logContext.contextCreatedAt,
    killSwitchEngaged: logContext.killSwitchEngaged,
    runtimeMode: logContext.runtimeMode,
    sessionPhase: logContext.sessionPhase,
    liveEnabled: logContext.liveEnabled,
    liveOrderSubmitted: entry.liveOrderSubmitted,
    durationMs: durationMs(logContext),
    recordedAt: new Date().toISOString()
  });
}

async function appendIncident(
  journals: LiveCycleJournals,
  logContext: LiveCycleLogContext,
  mirrorSink: MirrorEventSink | undefined,
  entry: {
    stage:
      | 'engine'
      | 'live-config'
      | 'reconciliation'
      | 'guards'
      | 'broadcast'
      | 'recovery'
      | 'runtime-policy';
    reason: string;
    severity: 'warning' | 'error';
    requestedPositionSol?: number;
    quote?: SolExitQuote;
    submissionId?: string;
    reconciliationDeltaSol?: number;
  }
) {
  const recordedAt = new Date().toISOString();
  const classification = classifyIncidentReason(entry.reason);
  const severity = entry.severity ?? classification.severity ?? 'warning';
  const dedupeKey = buildIncidentDedupeKey({
    kind: classification.kind,
    strategyId: logContext.strategyId,
    stage: entry.stage,
    reason: entry.reason,
    tokenMint: logContext.tokenMint,
    poolAddress: logContext.poolAddress
  });
  const dedupeDecision = await liveIncidentDedupeStore.shouldAppend(dedupeKey, {
    ttlMs: classification.kind === 'spend_limit_blocked' ? 24 * 60 * 60_000 : undefined
  });

  if (!dedupeDecision.append) {
    return;
  }

  await journals.incidents.append({
    cycleId: logContext.cycleId,
    strategyId: logContext.strategyId,
    stage: entry.stage,
    severity,
    kind: classification.kind,
    reason: entry.reason,
    rootCause: classification.rootCause,
    suggestedAction: classification.suggestedAction,
    dedupeKey,
    suppressedCount: dedupeDecision.duplicateCount,
    firstSeenAt: dedupeDecision.firstSeenAt,
    lastSeenAt: dedupeDecision.lastSeenAt,
    poolAddress: logContext.poolAddress,
    tokenSymbol: logContext.tokenSymbol,
    tokenMint: logContext.tokenMint,
    requestedPositionSol: entry.requestedPositionSol,
    routeExists: entry.quote?.routeExists ?? logContext.routeExists,
    quoteOutputSol: entry.quote?.outputSol,
    runtimeMode: logContext.runtimeMode,
    submissionId: entry.submissionId,
    reconciliationDeltaSol: entry.reconciliationDeltaSol,
    durationMs: durationMs(logContext),
    recordedAt
  });
  emitMirrorEvent(mirrorSink, () => {
    mirrorSink!.enqueue(toIncidentMirrorEvent({
      lifecycleKey: buildMirrorLifecycleKey({
        tokenMint: logContext.tokenMint
      }),
      incidentId: `${logContext.cycleId}:${entry.stage}:${recordedAt}`,
      cycleId: logContext.cycleId,
      stage: entry.stage,
      severity,
      reason: entry.reason,
      runtimeMode: logContext.runtimeMode,
      submissionId: entry.submissionId ?? '',
      tokenMint: logContext.tokenMint,
      tokenSymbol: logContext.tokenSymbol,
      recordedAt
    }));
  });
}

export async function runLiveCycle(input: LiveCycleInput): Promise<LiveCycleResult> {
  let currentLifecycleState: PositionLifecycleState = input.positionState?.lifecycleState ?? 'closed';
  const config = await loadStrategyConfig(STRATEGY_CONFIGS[input.strategy]);
  let accountState = input.accountState;
  const journals = createJournals(input.strategy, input.journalRootDir);
  const stateRootDir = resolveStateRootDir(input.strategy, input.stateRootDir);
  liveIncidentDedupeStore.configurePersistence(join(stateRootDir, 'incident-dedupe-state.json'));

  if (!accountState && input.accountProvider) {
    accountState = await input.accountProvider.readState();
  }

  const historicalFills = mergeHistoricalFills(accountState, await journals.fills.readAll());

  const forcedExitToken = findLargestNonStableInventory(accountState);
  const context = buildDecisionContext(
    forcedExitToken
      ? {
          ...(input.context ?? {}),
          token: {
            ...((input.context?.token as Record<string, unknown> | undefined) ?? {}),
            mint: forcedExitToken.mint,
            symbol: forcedExitToken.symbol ?? ((input.context?.token as Record<string, unknown> | undefined)?.symbol as string | undefined) ?? '',
            hasInventory: true
          },
          trader: {
            ...((input.context?.trader as Record<string, unknown> | undefined) ?? {}),
            hasInventory: true,
            hasLpPosition: false,
            lifecycleState: 'inventory_exit_ready'
          }
        }
      : (input.context ?? {})
  );
  const mirrorSink = input.mirrorSink;
  const killSwitch = input.killSwitch ?? new KillSwitch(false);
  const killSwitchState = killSwitch.isEngaged();
  const quoteProvider = input.quoteProvider ?? new StaticLiveQuoteProvider();
  const signer = input.signer ?? new TestLiveSigner();
  const broadcaster = input.broadcaster ?? new TestLiveBroadcaster();

  if (forcedExitToken) {
    currentLifecycleState = 'inventory_exit_ready';
  }

  maybePopulateLpNetPnlPct({
    context,
    positionState: input.positionState,
    config,
    requestedPositionSol: input.requestedPositionSol,
    fills: historicalFills
  });
  const snapshot = buildEngineSnapshot(config.poolClass, context);
  
  if (config.poolClass === 'new-token') {
    (snapshot as any).holdTimeMs = getHoldTimeMs({
      fills: historicalFills,
      mint: firstString(context.token.mint),
      nowMs: Date.now(),
      positionState: input.positionState
    });
  }

  const routeExists = Boolean(snapshot.hasSolRoute);
  const routeSlippageBps = firstNumber(context.route.slippageBps, config.solRouteLimits.maxSlippageBps);
  let tokenSymbol = firstString(context.token.symbol, context.route.token, context.token.mint);
  let poolAddress = firstString(context.pool.address, context.route.poolAddress, 'live-pool');
  const targetOpenCooldownStore = new TargetOpenCooldownStore(stateRootDir);
  await targetOpenCooldownStore.pruneExpired();
  const ingestBlockReason = firstString(context.route.blockReason, context.pool.blockReason, context.token.blockReason);
  const pendingSubmissionStore = new PendingSubmissionStore(
    stateRootDir
  );
  const runtimeMode = input.runtimeMode ?? 'healthy';
  const startedAt = new Date().toISOString();
  const logContext: LiveCycleLogContext = {
    cycleId: buildCycleId(input.strategy, startedAt),
    strategyId: input.strategy,
    startedAt,
    startedAtMs: Date.now(),
    contextCreatedAt: context.createdAt,
    engineReason: '',
    poolAddress,
    tokenSymbol,
    tokenMint: firstString(context.token.mint),
    routeExists,
    routeSlippageBps,
    killSwitchEngaged: killSwitchState,
    runtimeMode,
    sessionPhase: input.sessionPhase ?? 'active',
    liveEnabled: config.live.enabled
  };

  let reconciliationOk = (input.reconciliationStatus ?? 'matched') === 'matched';
  let currentRequestedPositionSol = input.requestedPositionSol ?? 0;

  context.trader.lifecycleState = currentLifecycleState;

  const finalize = (result: Omit<LiveCycleResult, 'nextLifecycleState'>, synchronouslyResolved?: boolean): LiveCycleResult => {
    let nextLifecycleState = resolveNextLifecycleState(
      currentLifecycleState,
      result.action,
      result.liveOrderSubmitted,
      synchronouslyResolved
    );

    const hasLivePendingSubmission = result.liveOrderSubmitted || pendingSubmission !== null;

    if (activeMint) {
      const unresolved = result.reason.includes('journal-open-unresolved') || result.reason.includes('mint-position-already-active:') || result.reason.includes('pending-open:');
      if (unresolved && hasLivePendingSubmission) {
        nextLifecycleState = 'open';
      } else if (!result.liveOrderSubmitted && !hasLivePendingSubmission && !hasNonStableInventory(accountState)) {
        nextLifecycleState = 'closed';
      }
    } else if (!result.liveOrderSubmitted && !hasLivePendingSubmission && !hasNonStableInventory(accountState)) {
      nextLifecycleState = 'closed';
    }

    emitMirrorEvent(mirrorSink, () => {
      mirrorSink!.enqueue(toCycleRunEvent(buildCycleRunMirrorPayload({
        cycleId: logContext.cycleId,
        strategyId: input.strategy,
        startedAt: logContext.startedAt,
        finishedAt: new Date().toISOString(),
        runtimeMode: logContext.runtimeMode,
        sessionPhase: logContext.sessionPhase,
        action: result.action,
        resultMode: result.mode,
        reason: result.reason,
        poolAddress: logContext.poolAddress,
        tokenMint: logContext.tokenMint,
        tokenSymbol: logContext.tokenSymbol,
        requestedPositionSol: currentRequestedPositionSol,
        quoteCollected: result.quoteCollected,
        liveOrderSubmitted: result.liveOrderSubmitted,
        confirmationStatus: result.confirmationStatus,
        reconciliationOk,
        durationMs: durationMs(logContext)
      })));
    });

    return { ...result, nextLifecycleState };
  };
  const blockCycle = async (entry: {
    stage: 'live-config' | 'reconciliation' | 'guards' | 'signer' | 'broadcast' | 'recovery' | 'runtime-policy';
    action: LiveAction;
    reason: string;
    audit: { reason: string };
    requestedPositionSol?: number;
    quote?: SolExitQuote;
    executionPlan?: ExecutionPlan;
    orderIntent?: LiveOrderIntent;
    broadcastResult?: LiveBroadcastResult;
    confirmationStatus?: ConfirmationStatus;
    failureKind?: ExecutionFailureKind;
    failureSource?: 'quote' | 'signer' | 'broadcast' | 'confirmation' | 'account' | 'recovery' | 'runtime-policy';
    reconciliationDeltaSol?: number;
    severity?: 'warning' | 'error';
    emitIncident?: boolean;
    quoteCollected: boolean;
  }) => {
    await appendDecision(journals, logContext, {
      stage: entry.stage,
      mode: 'BLOCKED',
      action: entry.action,
      reason: entry.reason,
      requestedPositionSol: entry.requestedPositionSol,
      quote: entry.quote,
      confirmationStatus: entry.confirmationStatus,
      submissionId: getBroadcastSubmissionId(entry.broadcastResult),
      reconciliationDeltaSol: entry.reconciliationDeltaSol,
      liveOrderSubmitted: false
    });

    if (entry.emitIncident ?? true) {
      await appendIncident(journals, logContext, mirrorSink, {
        stage: entry.stage,
        reason: entry.reason,
        severity: entry.severity ?? 'warning',
        requestedPositionSol: entry.requestedPositionSol,
        quote: entry.quote,
        submissionId: getBroadcastSubmissionId(entry.broadcastResult),
        reconciliationDeltaSol: entry.reconciliationDeltaSol
      });
    }

    return finalize(buildBlockedCycleResult({
      action: entry.action,
      reason: entry.reason,
      audit: entry.audit,
      context,
      quoteCollected: entry.quoteCollected,
      quote: entry.quote,
      executionPlan: entry.executionPlan,
      orderIntent: entry.orderIntent,
      broadcastResult: entry.broadcastResult,
      confirmationStatus: entry.confirmationStatus,
      failureKind: entry.failureKind,
      failureSource: entry.failureSource,
      journalPaths: journals.paths,
      killSwitchState
    }));
  };
  let pendingSubmission = await pendingSubmissionStore.read();
  if (config.poolClass === 'new-token') {
    (snapshot as any).pendingConfirmationStatus = resolvePendingConfirmationStatus({
      pendingSubmission,
      positionState: input.positionState,
      mint: firstString(context.token.mint)
    });
  }

  const multiLpExit = config.poolClass === 'new-token'
    ? selectTriggeredLpExit({ accountState, config, nowMs: Date.now(), fills: historicalFills, positionState: input.positionState })
    : null;
  if (multiLpExit && multiLpExit.position.mint) {
    context.token.mint = multiLpExit.position.mint;
    context.pool.address = multiLpExit.position.poolAddress;
    context.token.symbol = firstString(context.token.symbol, multiLpExit.position.mint);
    context.trader.hasLpPosition = true;
    context.trader.hasInventory = true;
    context.trader.lpCurrentValueSol = multiLpExit.position.currentValueSol;
    context.trader.lpUnclaimedFeeSol = multiLpExit.position.unclaimedFeeSol;
    context.trader.lpSolDepletedBins = multiLpExit.snapshot.lpSolDepletedBins;
    context.trader.lpSolExposureStatus = multiLpExit.snapshot.lpSolExposureStatus;
    context.trader.valuationStatus = multiLpExit.position.valuationStatus;
    context.trader.valuationReason = multiLpExit.position.valuationReason;
    context.trader.valuationSource = multiLpExit.position.valuationSource;
    context.trader.lpValuationStatus = multiLpExit.position.valuationStatus;
    context.trader.lpValuationReason = multiLpExit.position.valuationReason;
    context.trader.lpValuationSource = multiLpExit.position.valuationSource;
    if (typeof multiLpExit.snapshot.lpNetPnlPct === 'number') {
      context.trader.lpNetPnlPct = multiLpExit.snapshot.lpNetPnlPct;
    } else {
      delete context.trader.lpNetPnlPct;
    }
    context.trader.lpActiveBinStatus = multiLpExit.snapshot.lpActiveBinStatus as
      | 'in-range'
      | 'out-of-range'
      | undefined;
  }

  let activeMint = firstString(multiLpExit?.position.mint, logContext.tokenMint, context.token.mint);
  if (multiLpExit?.position.poolAddress) {
    poolAddress = multiLpExit.position.poolAddress;
    tokenSymbol = firstString(context.token.symbol, logContext.tokenSymbol, multiLpExit.position.mint);
    logContext.poolAddress = poolAddress;
    logContext.tokenMint = multiLpExit.position.mint;
    logContext.tokenSymbol = tokenSymbol;
  }

  const stateBoundOpenTarget = !multiLpExit
    ? resolveStateBoundOpenTarget({
        positionState: input.positionState,
        tokenMint: activeMint
      })
    : null;
  if (stateBoundOpenTarget) {
    poolAddress = stateBoundOpenTarget.activePoolAddress;
    context.pool.address = poolAddress;
    context.route.poolAddress = poolAddress;
    logContext.poolAddress = poolAddress;

    if (stateBoundOpenTarget.activeMint) {
      activeMint = stateBoundOpenTarget.activeMint;
      context.token.mint = stateBoundOpenTarget.activeMint;
      logContext.tokenMint = stateBoundOpenTarget.activeMint;
    }
  }

  const matchedActiveLpPosition = [
    ...(accountState?.walletLpPositions ?? []),
    ...(accountState?.journalLpPositions ?? [])
  ].find((position) => {
    if (!isManageableLpPosition(position)) {
      return false;
    }

    if (
      typeof input.positionState?.chainPositionAddress === 'string'
      && input.positionState.chainPositionAddress.length > 0
    ) {
      return position.positionAddress === input.positionState.chainPositionAddress;
    }

    return position.mint === input.positionState?.activeMint
      && position.poolAddress === input.positionState?.activePoolAddress;
  });

  if (
    config.poolClass === 'new-token'
    && currentLifecycleState === 'open'
    && matchedActiveLpPosition
    && (!input.positionState?.entrySol || !input.positionState?.openedAt)
  ) {
    await appendIncident(journals, logContext, mirrorSink, {
      stage: 'runtime-policy',
      severity: 'warning',
      reason: `lp-position-missing-entry-metadata:${matchedActiveLpPosition.mint || activeMint || 'unknown'}`,
      submissionId: pendingSubmission?.submissionId
    });
  }

  if (
    currentLifecycleState === 'open_pending' &&
    pendingSubmission &&
    accountState
  ) {
    const pendingMatchesActiveContext =
      !activeMint ||
      pendingSubmission.tokenMint === activeMint ||
      pendingSubmission.poolAddress === logContext.poolAddress;

    if (pendingMatchesActiveContext && !hasAnyWalletEvidenceForPendingSubmission(pendingSubmission, accountState)) {
      const evidenceKey = activeMint || pendingSubmission.tokenMint || pendingSubmission.poolAddress || 'unknown';
      return blockCycle({
        stage: 'runtime-policy',
        action: 'hold',
        reason: `mint-open-pending-recovery:${evidenceKey}`,
        audit: { reason: `mint-open-pending-recovery:${evidenceKey}` },
        severity: 'warning',
        failureSource: 'runtime-policy',
        quoteCollected: false
      });
    }
  }

  if (pendingSubmission) {
    const lifecycleBeforeRecovery = currentLifecycleState;
    const recoveryGate = await runPendingRecoveryGate({
      pendingSubmissionStore,
      pendingSubmission,
      confirmationProvider: input.confirmationProvider,
      accountState,
      currentLifecycleState
    });
    currentLifecycleState = recoveryGate.lifecycleState;
    context.trader.lifecycleState = currentLifecycleState;

    if (
      !recoveryGate.blocked
      && pendingSubmission
      && (
        recoveryGate.reason === 'pending-submission-confirmed'
        || recoveryGate.reason === 'pending-submission-filled'
        || recoveryGate.reason === 'pending-submission-failed'
      )
    ) {
      emitRecoveredOrderState({
        mirrorSink,
        pendingSubmission,
        recoveryReason: recoveryGate.reason,
        cycleId: logContext.cycleId,
        strategyId: input.strategy,
        poolAddress: logContext.poolAddress,
        tokenMint: logContext.tokenMint,
        tokenSymbol: logContext.tokenSymbol,
        updatedAt: new Date().toISOString()
      });
    }

    pendingSubmission = await pendingSubmissionStore.read();

    if (recoveryGate.blocked) {
      return blockCycle({
        stage: 'recovery',
        action: 'hold',
        reason: recoveryGate.reason,
        audit: { reason: recoveryGate.reason },
        severity: recoveryGate.reason === 'pending-submission-timeout' ? 'error' : 'warning',
        failureKind: recoveryGate.reason === 'pending-submission-timeout' ? 'unknown' : undefined,
        failureSource: 'recovery',
        quoteCollected: false
      });
    }

    if (
      recoveryGate.reason === 'pending-submission-confirmed'
      || recoveryGate.reason === 'pending-submission-filled'
    ) {
      await appendDecision(journals, logContext, {
        stage: 'recovery',
        mode: 'LIVE',
        action: 'hold',
        reason: recoveryGate.reason,
        liveOrderSubmitted: false
      });
    }

    if (
      activeMint &&
      lifecycleBeforeRecovery === 'open_pending' &&
      recoveryGate.reason === 'pending-submission-failed'
    ) {
      return blockCycle({
        stage: 'recovery',
        action: 'hold',
        reason: `failed-open-cooldown:${activeMint}`,
        audit: { reason: `failed-open-cooldown:${activeMint}` },
        severity: 'warning',
        failureSource: 'recovery',
        quoteCollected: false
      });
    }
  }

  if (ingestBlockReason && !multiLpExit) {
    logContext.engineReason = ingestBlockReason;
    await appendDecision(journals, logContext, {
      stage: 'engine',
      mode: 'BLOCKED',
      action: 'hold',
      reason: ingestBlockReason,
      liveOrderSubmitted: false
    });

    return finalize(buildBlockedCycleResult({
      action: 'hold',
      reason: ingestBlockReason,
      audit: { reason: ingestBlockReason },
      context,
      quoteCollected: false,
      journalPaths: journals.paths,
      killSwitchState
    }));
  }

  const preEngineMintAggregate = await resolveMintPositionAggregate({
    mint: activeMint,
    pendingSubmission,
    accountState,
    lifecycleState: currentLifecycleState,
    orders: journals.orders,
    fills: journals.fills
  });

  if (preEngineMintAggregate.mustCleanupDust) {
    currentLifecycleState = 'inventory_exit_ready';
    context.trader.lifecycleState = currentLifecycleState;
    context.trader.hasInventory = true;
    context.trader.hasLpPosition = false;
  }

  const updatedSnapshot = buildEngineSnapshot(config.poolClass, context);
  const liveLpCurrentValueSol = typeof context.trader.lpCurrentValueSol === 'number'
    ? context.trader.lpCurrentValueSol
    : undefined;
  const liveLpUnclaimedFeeSol = typeof context.trader.lpUnclaimedFeeSol === 'number'
    ? context.trader.lpUnclaimedFeeSol
    : undefined;
  const liveLpValuation = config.poolClass === 'new-token' && context.trader.hasLpPosition
    ? (typeof context.trader.valuationStatus === 'string'
      ? {
        valuationStatus: context.trader.valuationStatus as any,
        valuationReason: firstString(context.trader.valuationReason),
        lastValuationAt: new Date().toISOString()
      }
      : evaluateLpValuationState({
        currentValueSol: liveLpCurrentValueSol,
        unclaimedFeeSol: liveLpUnclaimedFeeSol,
        observedAt: new Date().toISOString()
      }))
    : null;
  if (config.poolClass === 'new-token') {
    (updatedSnapshot as any).holdTimeMs = typeof multiLpExit?.snapshot.holdTimeMs === 'number'
      ? multiLpExit.snapshot.holdTimeMs
      : (snapshot as any).holdTimeMs;
    (updatedSnapshot as any).pendingConfirmationStatus = typeof multiLpExit?.snapshot.pendingConfirmationStatus === 'string'
      ? multiLpExit.snapshot.pendingConfirmationStatus
      : (snapshot as any).pendingConfirmationStatus;
    (updatedSnapshot as any).valuationStatus = liveLpValuation?.valuationStatus;
    (updatedSnapshot as any).valuationReason = liveLpValuation?.valuationReason;
    (updatedSnapshot as any).valuationSource = firstString(context.trader.valuationSource, context.trader.lpValuationSource);
    if (typeof (updatedSnapshot as any).lpSolExposureStatus !== 'string') {
      (updatedSnapshot as any).lpSolExposureStatus = deriveLpSolExposureStatus({
        solDepletedBins: typeof (updatedSnapshot as any).lpSolDepletedBins === 'number'
          ? (updatedSnapshot as any).lpSolDepletedBins
          : undefined,
        solDepletionExitBins: config.lpConfig?.solDepletionExitBins
      });
    }
    if (preEngineMintAggregate.mustCleanupDust) {
      (updatedSnapshot as any).hasInventory = true;
      (updatedSnapshot as any).hasLpPosition = false;
      (updatedSnapshot as any).lifecycleState = 'inventory_exit_ready';
    }
  }
  const engineResult = multiLpExit?.decision ?? runEngineCycle({
    engine: config.poolClass,
    snapshot: updatedSnapshot,
    config: {
      maxHoldHours: config.live.maxHoldHours ?? 18,
      requireSolRoute: config.hardGates.requireSolRoute,
      minLiquidityUsd: config.hardGates.minLiquidityUsd,
      minPoolAgeMinutes: config.hardGates.minPoolAgeMinutes,
      maxPoolAgeMinutes: config.hardGates.maxPoolAgeMinutes,
      takeProfitPct: config.riskThresholds.takeProfitPct,
      stopLossPct: config.riskThresholds.stopLossPct,
      lpEnabled: config.lpConfig?.enabled ?? false,
      lpStopLossNetPnlPct: config.lpConfig?.stopLossNetPnlPct,
      lpTakeProfitNetPnlPct: config.lpConfig?.takeProfitNetPnlPct,
      lpMinHoldMinutesBeforeTakeProfit: 5,
      lpSolDepletionExitBins: config.lpConfig?.solDepletionExitBins,
      lpClaimFeeThresholdUsd: config.lpConfig?.claimFeeThresholdUsd,
      lpRebalanceOnOutOfRange: config.lpConfig?.rebalanceOnOutOfRange ?? false,
      lpMaxImpermanentLossPct: config.lpConfig?.maxImpermanentLossPct
    }
  });
  const lpEnabled = config.lpConfig?.enabled ?? false;
  const lpAuditMetrics = [
    `entrySol=${typeof input.positionState?.entrySol === 'number' ? input.positionState.entrySol.toFixed(9) : 'n/a'}`,
    `lpCurrentValueSol=${typeof context.trader.lpCurrentValueSol === 'number' ? context.trader.lpCurrentValueSol.toFixed(9) : 'n/a'}`,
    `lpUnclaimedFeeSol=${typeof context.trader.lpUnclaimedFeeSol === 'number' ? context.trader.lpUnclaimedFeeSol.toFixed(9) : 'n/a'}`,
    `lpNetPnlPct=${typeof context.trader.lpNetPnlPct === 'number' ? context.trader.lpNetPnlPct.toFixed(2) : 'n/a'}`,
    `lpSolExposureStatus=${typeof (updatedSnapshot as any).lpSolExposureStatus === 'string' ? (updatedSnapshot as any).lpSolExposureStatus : 'n/a'}`,
    `valuationStatus=${typeof (updatedSnapshot as any).valuationStatus === 'string' ? (updatedSnapshot as any).valuationStatus : 'n/a'}`,
    `valuationReason=${typeof (updatedSnapshot as any).valuationReason === 'string' ? (updatedSnapshot as any).valuationReason : 'n/a'}`,
    `valuationSource=${typeof (updatedSnapshot as any).valuationSource === 'string' ? (updatedSnapshot as any).valuationSource : 'n/a'}`,
    `holdTimeMs=${typeof (updatedSnapshot as any).holdTimeMs === 'number' ? String((updatedSnapshot as any).holdTimeMs) : 'n/a'}`,
    `pendingConfirmationStatus=${typeof (updatedSnapshot as any).pendingConfirmationStatus === 'string' ? (updatedSnapshot as any).pendingConfirmationStatus : 'n/a'}`
  ];
  const engineAuditParts = [
    engineResult.audit.reason,
    `lpEnabled=${lpEnabled}`,
    `hasLpPosition=${'hasLpPosition' in updatedSnapshot ? updatedSnapshot.hasLpPosition ?? false : false}`,
    `hasInventory=${'hasInventory' in updatedSnapshot ? updatedSnapshot.hasInventory ?? false : false}`,
    `lifecycleState=${'lifecycleState' in updatedSnapshot ? updatedSnapshot.lifecycleState ?? 'unknown' : 'n/a'}`,
    ...lpAuditMetrics
  ];

  const engineAuditReason = engineAuditParts.join(' | ');
  logContext.engineReason = engineAuditReason;

  if (engineResult.action === 'hold') {
    const blockedReason = liveLpValuation && liveLpValuation.valuationStatus !== 'ready'
      ? `valuation-unavailable:${liveLpValuation.valuationReason}`
      : 'hold';
    if (liveLpValuation && liveLpValuation.valuationStatus !== 'ready') {
      await appendIncident(journals, logContext, mirrorSink, {
        stage: 'engine',
        reason: blockedReason,
        severity: liveLpValuation.valuationStatus === 'invalid' ? 'error' : 'warning'
      });
    }
    await appendDecision(journals, logContext, {
      stage: 'engine',
      mode: 'BLOCKED',
      action: 'hold',
      reason: engineAuditReason,
      liveOrderSubmitted: false
    });

    return finalize(buildBlockedCycleResult({
      action: 'hold',
      reason: blockedReason,
      audit: engineResult.audit,
      context,
      quoteCollected: false,
      journalPaths: journals.paths,
      killSwitchState
    }));
  }

  const runtimeAction = applyRuntimeActionPolicy({
    mode: runtimeMode,
    action: engineResult.action
  });

  const mintAggregate = preEngineMintAggregate;

  const recentCloseMint = input.positionState?.lastClosedMint ?? '';
  const recentCloseAt = input.positionState?.lastClosedAt ?? '';
  const reopenCooldownMs = RECENTLY_CLOSED_MINT_REOPEN_COOLDOWN_MS;
  const isRecentlyClosedSameMint = Boolean(
    activeMint &&
    recentCloseMint === activeMint &&
    recentCloseAt &&
    (Date.now() - Date.parse(recentCloseAt)) < reopenCooldownMs
  );

  if (
    !multiLpExit &&
    activeMint &&
    (runtimeAction.action === 'deploy' || runtimeAction.action === 'add-lp') &&
    isRecentlyClosedSameMint
  ) {
    return blockCycle({
      stage: 'runtime-policy',
      action: 'hold',
      reason: `recently-closed-mint:${activeMint}`,
      audit: { reason: `recently-closed-mint:${activeMint}` },
      severity: 'warning',
      failureSource: 'runtime-policy',
      quoteCollected: false
    });
  }

  if (
    !multiLpExit &&
    activeMint &&
    (runtimeAction.action === 'deploy' || runtimeAction.action === 'add-lp')
  ) {
    const activeTargetCooldown = await targetOpenCooldownStore.readActive({
      poolAddress,
      tokenMint: activeMint
    });

    if (activeTargetCooldown) {
      return blockCycle({
        stage: 'runtime-policy',
        action: 'hold',
        reason: `open-rate-limit-cooldown:${activeMint}`,
        audit: {
          reason: `open-rate-limit-cooldown:${activeMint}`
        },
        severity: 'warning',
        failureSource: 'runtime-policy',
        quoteCollected: false
      });
    }
  }

  if (
    !multiLpExit &&
    activeMint &&
    (runtimeAction.action === 'deploy' || runtimeAction.action === 'add-lp') &&
    !mintAggregate.canOpen
  ) {
    return blockCycle({
      stage: 'runtime-policy',
      action: 'hold',
      reason: `mint-position-already-active:${activeMint}:${mintAggregate.reason}`,
      audit: { reason: `mint-position-already-active:${activeMint}:${mintAggregate.reason}` },
      severity: 'warning',
      failureSource: 'runtime-policy',
      quoteCollected: false
    });
  }

  if (runtimeAction.action === 'hold' && runtimeAction.blockedReason) {
    return blockCycle({
      stage: 'runtime-policy',
      action: 'hold',
      reason: runtimeAction.blockedReason,
      audit: engineResult.audit,
      failureSource: 'runtime-policy',
      emitIncident: false,
      quoteCollected: false
    });
  }

  const actionableAction = runtimeAction.action;
  const actionableTokenMint = activeMint || logContext.tokenMint;

  if (
    actionableAction === 'dca-out' &&
    hasPositiveWalletTokenBalance({
      accountState,
      tokenMint: actionableTokenMint
    }) === false
  ) {
    return blockCycle({
      stage: 'runtime-policy',
      action: 'hold',
      reason: `zero_token_balance_resolved:${actionableTokenMint}`,
      audit: { reason: `zero_token_balance_resolved:${actionableTokenMint}` },
      severity: 'warning',
      failureSource: 'runtime-policy',
      quoteCollected: false
    });
  }

  const activeLpExitPositionSol = resolveActiveLpExitPositionSol({
    action: actionableAction,
    positionState: input.positionState
  });
  const quotedPositionSol = firstNumber(
    activeLpExitPositionSol,
    context.route.expectedOutSol,
    context.token.expectedOutSol,
    context.pool.expectedOutSol,
    input.requestedPositionSol
  );
  const quote = await quoteProvider.collect({
    expectedOutSol: quotedPositionSol,
    slippageBps: routeSlippageBps,
    routeExists
  });

  const requestedPositionSol = resolveRequestedPositionSol({
    activeLpExitPositionSol,
    requestedPositionSol: input.requestedPositionSol,
    quoteOutputSol: quote.outputSol
  });
  currentRequestedPositionSol = requestedPositionSol;
  await journals.quotes.append({
    cycleId: logContext.cycleId,
    strategyId: input.strategy,
    poolAddress,
    tokenSymbol,
    requestedPositionSol,
    ...quote
  });

  const executionPlan = {
    strategyId: input.strategy,
    poolAddress,
    exitMint: 'SOL',
    maxSlippageBps: 100,
    maxImpactBps: 200,
    solExitQuote: quote
  } satisfies ExecutionPlan;

  if (!config.live.enabled) {
    return blockCycle({
      stage: 'live-config',
      action: actionableAction,
      reason: 'strategy-live-disabled',
      audit: engineResult.audit,
      requestedPositionSol,
      quote,
      executionPlan,
      severity: 'warning',
      quoteCollected: true
    });
  }

  if ((input.reconciliationStatus ?? 'matched') !== 'matched') {
    reconciliationOk = false;
    if (hasReduceRiskWalletExposure({
      action: actionableAction,
      accountState,
      tokenMint: logContext.tokenMint,
      poolAddress,
      chainPositionAddress: multiLpExit?.position.positionAddress ?? input.positionState?.chainPositionAddress
    })) {
      await appendIncident(journals, logContext, mirrorSink, {
        stage: 'reconciliation',
        reason: 'reconciliation-required:reduce-risk-allowed',
        severity: 'warning',
        requestedPositionSol,
        quote
      });
    } else {
      return blockCycle({
        stage: 'reconciliation',
        action: actionableAction,
        reason: 'reconciliation-required',
        audit: engineResult.audit,
        requestedPositionSol,
        quote,
        executionPlan,
        severity: 'warning',
        quoteCollected: true
      });
    }
  }

  if (accountState || input.accountProvider) {
    const reconciliation = runAccountReconciliationGate(accountState);
    if (!reconciliation) {
      throw new Error('Expected reconciliation input when account state is available');
    }
    reconciliationOk = reconciliation.ok;
    emitMirrorEvent(mirrorSink, () => {
      mirrorSink!.enqueue(toReconciliationMirrorEvent({
        cycleId: logContext.cycleId,
        walletSol: accountState!.walletSol,
        journalSol: accountState!.journalSol,
        deltaSol: reconciliation.deltaSol,
        tokenDeltaCount: reconciliation.tokenDeltas.length,
        ok: reconciliation.ok,
        reason: reconciliation.reason,
        recordedAt: new Date().toISOString(),
        rawJson: JSON.stringify(reconciliation)
      }));
    });

    if (!reconciliation.ok) {
      if (hasReduceRiskWalletExposure({
        action: actionableAction,
        accountState,
        tokenMint: logContext.tokenMint,
        poolAddress,
        chainPositionAddress: multiLpExit?.position.positionAddress ?? input.positionState?.chainPositionAddress
      })) {
        await appendIncident(journals, logContext, mirrorSink, {
          stage: 'reconciliation',
          reason: `${reconciliation.reason}:reduce-risk-allowed`,
          severity: 'warning',
          requestedPositionSol,
          quote,
          reconciliationDeltaSol: reconciliation.deltaSol
        });
      } else {
        return blockCycle({
          stage: 'reconciliation',
          action: actionableAction,
          reason: reconciliation.reason,
          audit: engineResult.audit,
          requestedPositionSol,
          quote,
          executionPlan,
          reconciliationDeltaSol: reconciliation.deltaSol,
          severity: 'warning',
          quoteCollected: true
        });
      }
    }
  }

  const spendingLimitsStore = input.spendingLimitsConfig
    ? new SpendingLimitsStore(stateRootDir)
    : undefined;
  const spendingState = spendingLimitsStore
    ? await spendingLimitsStore.read()
    : undefined;

  const guardResult = evaluateLiveGuards({
    action: actionableAction,
    symbol: tokenSymbol,
    requestedPositionSol,
    maxLivePositionSol: config.live.maxLivePositionSol,
    killSwitchEngaged: killSwitchState,
    sessionPhase: logContext.sessionPhase,
    maxSingleOrderSol: input.spendingLimitsConfig?.maxSingleOrderSol,
    maxHourlySpendSol: input.spendingLimitsConfig?.maxHourlySpendSol,
    maxDailySpendSol: input.spendingLimitsConfig?.maxDailySpendSol,
    hourlySpendSol: spendingState?.hourlySpendSol,
    dailySpendSol: spendingState?.dailySpendSol,
    mintAuthorityRevoked: typeof context.token.mintAuthorityRevoked === 'boolean' ? context.token.mintAuthorityRevoked : undefined,
    requireMintAuthorityRevoked: config.live.requireMintAuthorityRevoked,
    lpBurnedPct: typeof context.token.lpBurnedPct === 'number' ? context.token.lpBurnedPct : undefined,
    requireLpBurnedPct: config.live.requireLpBurnedPct,
    top10HoldersPct: typeof context.token.top10HoldersPct === 'number' ? context.token.top10HoldersPct : undefined,
    maxTop10HoldersPct: config.live.maxTop10HoldersPct
  });
  const actionableActionClass = classifyAction(actionableAction);

  if (!guardResult.allowed) {
    return blockCycle({
      stage: 'guards',
      action: actionableAction,
      reason: guardResult.reason,
      audit: engineResult.audit,
      requestedPositionSol,
      quote,
      executionPlan,
      severity: 'warning',
      quoteCollected: true
    });
  }

  const orderIntent = buildOrderIntent({
    strategyId: input.strategy,
    poolAddress: executionPlan.poolAddress,
    outputSol: requestedPositionSol,
    side: resolveOrderIntentSide(actionableAction),
    tokenMint: logContext.tokenMint,
    fullPositionExit: isFullPositionExitAction(actionableAction),
    liquidateResidualTokenToSol: actionableAction === 'withdraw-lp' || actionableAction === 'claim-fee'
  });
  const actionIdentity = resolveActionIdentity({
    action: actionableAction,
    positionState: input.positionState,
    pendingSubmission,
    poolAddress: executionPlan.poolAddress,
    tokenMint: logContext.tokenMint,
    chainPositionAddress: multiLpExit?.position.positionAddress
  });
  const orderLifecycleKey = buildMirrorLifecycleKey({
    tokenMint: logContext.tokenMint,
    openIntentId: actionIdentity.openIntentId,
    positionId: actionIdentity.positionId,
    chainPositionAddress: actionIdentity.chainPositionAddress
  });
  const appendOrderLifecycleState = async (entry: {
    submissionId?: string;
    confirmationSignature?: string;
    broadcastStatus: OrderBroadcastStatus;
    confirmationStatus: ConfirmationStatus;
    finality?: PendingFinality | 'unknown';
    updatedAt: string;
  }) => {
    await journals.orders.append({
      cycleId: logContext.cycleId,
      ...orderIntent,
      submissionId: entry.submissionId ?? '',
      openIntentId: actionIdentity.openIntentId,
      positionId: actionIdentity.positionId,
      chainPositionAddress: actionIdentity.chainPositionAddress,
      confirmationSignature: entry.confirmationSignature ?? '',
      requestedPositionSol,
      quotedOutputSol: quote.outputSol,
      routeExists: quote.routeExists,
      broadcastStatus: entry.broadcastStatus,
      confirmationStatus: entry.confirmationStatus,
      finality: entry.finality ?? 'unknown',
      updatedAt: entry.updatedAt
    });
    emitMirrorEvent(mirrorSink, () => {
      mirrorSink!.enqueue(toOrderMirrorEvent(buildOrderMirrorPayload({
        lifecycleKey: orderLifecycleKey,
        idempotencyKey: orderIntent.idempotencyKey,
        cycleId: logContext.cycleId,
        strategyId: input.strategy,
        submissionId: entry.submissionId ?? '',
        openIntentId: actionIdentity.openIntentId,
        positionId: actionIdentity.positionId,
        chainPositionAddress: actionIdentity.chainPositionAddress,
        confirmationSignature: entry.confirmationSignature ?? '',
        poolAddress: executionPlan.poolAddress,
        tokenMint: logContext.tokenMint,
        tokenSymbol,
        action: actionableAction,
        requestedPositionSol,
        quotedOutputSol: quote.outputSol,
        broadcastStatus: entry.broadcastStatus,
        confirmationStatus: entry.confirmationStatus,
        finality: entry.finality ?? 'unknown',
        createdAt: logContext.startedAt,
        updatedAt: entry.updatedAt
      })));
    });
  };

  let signedIntent: SignedLiveOrderIntent;
  try {
    signedIntent = await signer.sign(orderIntent);
  } catch (error) {
    const updatedAt = new Date().toISOString();
    const reason = error instanceof ExecutionRequestError
      ? error.reason
      : error instanceof Error && error.message.length > 0
        ? error.message
        : 'signer-request-failed';
    await appendOrderLifecycleState({
      broadcastStatus: 'not_submitted',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      updatedAt
    });

    return blockCycle({
      stage: 'signer',
      action: actionableAction,
      reason,
      audit: engineResult.audit,
      requestedPositionSol,
      quote,
      executionPlan,
      orderIntent,
      confirmationStatus: 'unknown',
      failureKind: error instanceof ExecutionRequestError ? error.kind : 'hard',
      failureSource: 'signer',
      severity: 'error',
      quoteCollected: true
    });
  }
  let broadcastResult: LiveBroadcastResult;

  try {
    broadcastResult = await broadcaster.broadcast(signedIntent);
  } catch (error) {
    if (error instanceof ExecutionRequestError && error.kind === 'unknown') {
      const updatedAt = new Date().toISOString();
      pendingSubmission = buildUnknownPendingSubmissionSnapshot({
        strategyId: input.strategy,
        idempotencyKey: orderIntent.idempotencyKey,
        openIntentId: actionIdentity.openIntentId,
        positionId: actionIdentity.positionId,
        chainPositionAddress: actionIdentity.chainPositionAddress,
        createdAt: logContext.startedAt,
        updatedAt,
        timeoutAt: buildPendingTimeoutAt(logContext.startedAt),
        poolAddress: executionPlan.poolAddress,
        tokenMint: logContext.tokenMint,
        tokenSymbol,
        orderAction: actionableAction,
        reason: error.reason
      });
      await pendingSubmissionStore.write(pendingSubmission);
      await appendOrderLifecycleState({
        broadcastStatus: 'unknown',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        updatedAt
      });

      return blockCycle({
        stage: 'broadcast',
        action: actionableAction,
        reason: error.reason,
        audit: engineResult.audit,
        requestedPositionSol,
        quote,
        executionPlan,
        orderIntent,
        confirmationStatus: 'unknown',
        failureKind: error.kind,
        failureSource: 'broadcast',
        severity: 'error',
        quoteCollected: true
      });
    }

    const updatedAt = new Date().toISOString();
    const reason = error instanceof ExecutionRequestError
      ? error.reason
      : error instanceof Error && error.message.length > 0
        ? error.message
        : 'broadcast-request-failed';
    await appendOrderLifecycleState({
      broadcastStatus: 'not_submitted',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      updatedAt
    });

    return blockCycle({
      stage: 'broadcast',
      action: actionableAction,
      reason,
      audit: engineResult.audit,
      requestedPositionSol,
      quote,
      executionPlan,
      orderIntent,
      confirmationStatus: 'unknown',
      failureKind: error instanceof ExecutionRequestError ? error.kind : 'hard',
      failureSource: 'broadcast',
      severity: 'error',
      quoteCollected: true
    });
  }

  if (broadcastResult.status !== 'submitted') {
    const confirmation: {
      status: ConfirmationStatus;
      reason?: string;
    } = {
      status: 'unknown',
      reason: broadcastResult.reason
    };
    await appendOrderLifecycleState({
      broadcastStatus: 'not_submitted',
      confirmationStatus: confirmation.status,
      finality: 'unknown',
      updatedAt: new Date().toISOString()
    });

    return blockCycle({
      stage: 'broadcast',
      action: actionableAction,
      reason: broadcastResult.reason,
      audit: engineResult.audit,
      requestedPositionSol,
      quote,
      executionPlan,
      orderIntent,
      broadcastResult,
      confirmationStatus: confirmation.status,
      failureSource: 'broadcast',
      severity: 'error',
      quoteCollected: true
    });
  }

  let confirmation: {
    status: ConfirmationStatus;
    submissionId?: string;
    reason?: string;
  } = trackConfirmation({
    submissionId: broadcastResult.submissionId,
    confirmationSignature: broadcastResult.confirmationSignature
  });
  let confirmationFinality: ConfirmationFinality = 'unknown';
  let confirmationCheckedAt = new Date().toISOString();
  const trackedBroadcastSubmissions = getBroadcastTrackedSubmissions(broadcastResult);

  if (input.confirmationProvider && trackedBroadcastSubmissions.length > 0) {
    const polledConfirmations = await Promise.all(
      trackedBroadcastSubmissions.map((trackedSubmission) => input.confirmationProvider!.poll(trackedSubmission))
    );
    const normalizedConfirmations = polledConfirmations.map(toConfirmationResult);
    const aggregateConfirmation = aggregateTrackedConfirmations(normalizedConfirmations);

    confirmation = aggregateConfirmation.confirmation;
    confirmationFinality = aggregateConfirmation.finality;
    confirmationCheckedAt = aggregateConfirmation.checkedAt;
  }

  if (broadcastResult.batchStatus === 'partial') {
    confirmation = {
      status: 'unknown',
      submissionId: trackedBroadcastSubmissions[trackedBroadcastSubmissions.length - 1]?.submissionId ?? broadcastResult.submissionId,
      reason: 'pending-submission-partial-failure'
    };
    confirmationFinality = 'unknown';
  }

  pendingSubmission = buildTrackedPendingSubmissionSnapshot({
    strategyId: input.strategy,
    idempotencyKey: orderIntent.idempotencyKey,
    submissionId: broadcastResult.submissionId,
    openIntentId: actionIdentity.openIntentId,
    positionId: actionIdentity.positionId,
    chainPositionAddress: actionIdentity.chainPositionAddress,
    submissionIds: trackedBroadcastSubmissions.map((trackedSubmission) => trackedSubmission.submissionId),
    confirmationSignature: broadcastResult.confirmationSignature,
    confirmationSignatures: trackedBroadcastSubmissions.map((trackedSubmission) =>
      trackedSubmission.confirmationSignature ?? trackedSubmission.submissionId
    ),
    confirmationStatus: confirmation.status,
    finality: confirmationFinality,
    createdAt: logContext.startedAt,
    updatedAt: confirmationCheckedAt,
    timeoutAt: buildPendingTimeoutAt(logContext.startedAt),
    poolAddress: executionPlan.poolAddress,
    tokenMint: logContext.tokenMint,
    tokenSymbol,
    orderAction: actionableAction,
    reason: confirmation.reason ?? broadcastResult.reason
  });
  await pendingSubmissionStore.write(pendingSubmission);

  if (isResolvedConfirmation(confirmation.status, confirmationFinality)) {
    await pendingSubmissionStore.clear();
    pendingSubmission = null;
  }

  if (
    spendingLimitsStore &&
    actionableActionClass === 'open_risk' &&
    (confirmation.status === 'submitted' || isResolvedConfirmation(confirmation.status, confirmationFinality))
  ) {
    await spendingLimitsStore.reserveSpend(orderIntent.idempotencyKey, requestedPositionSol);
  }
  await appendOrderLifecycleState({
    submissionId: broadcastResult.submissionId,
    confirmationSignature: broadcastResult.confirmationSignature,
    broadcastStatus: 'submitted',
    confirmationStatus: confirmation.status,
    finality: confirmationFinality,
    updatedAt: confirmationCheckedAt
  });

  if (broadcastResult.batchStatus === 'partial') {
    const partialReason = broadcastResult.reason
      ? 'pending-submission-partial-failure: ' + broadcastResult.reason
      : 'pending-submission-partial-failure';

    await appendDecision(journals, logContext, {
      stage: 'broadcast',
      mode: 'BLOCKED',
      action: actionableAction,
      reason: partialReason,
      requestedPositionSol,
      quote,
      confirmationStatus: confirmation.status,
      submissionId: broadcastResult.submissionId,
      liveOrderSubmitted: true
    });
    await appendIncident(journals, logContext, mirrorSink, {
      stage: 'broadcast',
      reason: partialReason,
      severity: 'error',
      requestedPositionSol,
      quote,
      submissionId: broadcastResult.submissionId
    });

    return finalize({
      ...buildBlockedCycleResult({
        action: actionableAction,
        reason: partialReason,
        audit: engineResult.audit,
        context,
        quoteCollected: true,
        quote,
        executionPlan,
        orderIntent,
        broadcastResult,
        confirmationStatus: confirmation.status,
        failureKind: 'unknown',
        failureSource: 'broadcast',
        journalPaths: journals.paths,
        killSwitchState
      }),
      liveOrderSubmitted: true
    });
  }
  const fillRecordedAt = new Date().toISOString();
  let fillEvidenceMissing = false;
  let confirmedFill: LiveCycleConfirmedFill | undefined;
  const isConfirmedFill = isConfirmedConfirmation(confirmation.status, confirmationFinality);
  if (isConfirmedFill) {
    const actualFill = await resolveActualFillAmount({
      action: actionableAction,
      beforeAccountState: accountState,
      accountProvider: input.accountProvider,
      fallbackSol: requestedPositionSol
    });
    if (!actualFill.hasFillEvidence) {
      fillEvidenceMissing = true;
      await appendIncident(journals, logContext, mirrorSink, {
        stage: 'recovery',
        reason: 'unknown_pending_reconciliation:missing-fill-evidence',
        severity: 'warning',
        requestedPositionSol,
        quote,
        submissionId: broadcastResult.submissionId
      });
    } else {
      const mirroredFilledSol = actualFill.filledSol;
      confirmedFill = {
        submissionId: broadcastResult.submissionId,
        mint: logContext.tokenMint,
        side: actionableAction,
        filledSol: mirroredFilledSol,
        actualFilledSol: actualFill.actualFilledSol,
        actualWalletDeltaSol: actualFill.actualWalletDeltaSol,
        fillAmountSource: actualFill.fillAmountSource,
        recordedAt: fillRecordedAt,
        hasFillEvidence: actualFill.hasFillEvidence
      };
      if (spendingLimitsStore && actionableActionClass === 'open_risk') {
        await spendingLimitsStore.settleSpend(orderIntent.idempotencyKey, mirroredFilledSol);
      }
      await journals.fills.append({
        cycleId: logContext.cycleId,
        submissionId: broadcastResult.submissionId,
        strategyId: input.strategy,
        openIntentId: actionIdentity.openIntentId,
        positionId: actionIdentity.positionId,
        chainPositionAddress: actionIdentity.chainPositionAddress,
        mint: logContext.tokenMint,
        symbol: tokenSymbol,
        side: actionableAction,
        amount: mirroredFilledSol,
        filledSol: mirroredFilledSol,
        actualFilledSol: actualFill.actualFilledSol,
        actualWalletDeltaSol: actualFill.actualWalletDeltaSol,
        preWalletSol: actualFill.preWalletSol,
        postWalletSol: actualFill.postWalletSol,
        fillAmountSource: actualFill.fillAmountSource,
        hasFillEvidence: actualFill.hasFillEvidence,
        status: 'confirmed',
        confirmationStatus: confirmation.status,
        requestedPositionSol,
        recordedAt: fillRecordedAt
      });
      emitMirrorEvent(mirrorSink, () => {
        mirrorSink!.enqueue(toFillMirrorEvent({
          lifecycleKey: buildMirrorLifecycleKey({
            tokenMint: logContext.tokenMint,
            openIntentId: actionIdentity.openIntentId,
            positionId: actionIdentity.positionId,
            chainPositionAddress: actionIdentity.chainPositionAddress
          }),
          fillId: `${broadcastResult.submissionId}:${fillRecordedAt}`,
          submissionId: broadcastResult.submissionId,
          openIntentId: actionIdentity.openIntentId,
          positionId: actionIdentity.positionId,
          chainPositionAddress: actionIdentity.chainPositionAddress,
          confirmationSignature: broadcastResult.confirmationSignature ?? '',
          cycleId: logContext.cycleId,
          tokenMint: logContext.tokenMint,
          tokenSymbol,
          side: resolveFillMirrorSide(actionableAction),
          amount: mirroredFilledSol,
          filledSol: mirroredFilledSol,
          actualFilledSol: actualFill.actualFilledSol,
          actualWalletDeltaSol: actualFill.actualWalletDeltaSol,
          fillAmountSource: actualFill.fillAmountSource,
          hasFillEvidence: actualFill.hasFillEvidence,
          preWalletSol: actualFill.preWalletSol,
          postWalletSol: actualFill.postWalletSol,
          recordedAt: fillRecordedAt
        }));
      });
    }
  }
  await appendDecision(journals, logContext, {
    stage: 'broadcast',
    mode: 'LIVE',
    action: actionableAction,
    reason: 'live-order-submitted',
    requestedPositionSol,
    quote,
    confirmationStatus: confirmation.status,
    submissionId: broadcastResult.submissionId,
    liveOrderSubmitted: true
  });

  if (!fillEvidenceMissing) {
    await appendEvolutionOutcomeBestEffort({
      sink: input.evolutionSink,
      logContext,
      action: actionableAction,
      actualExitReason: engineResult.audit.reason,
      liveOrderSubmitted: true,
      config,
      context,
      snapshot: updatedSnapshot,
      positionState: input.positionState,
      confirmedFill,
      requestedPositionSol,
      quote
    });
  }

  const lifecycleSynchronouslyResolved = isConfirmedConfirmation(confirmation.status, confirmationFinality)
    && !fillEvidenceMissing;

  return finalize({
    ...buildLiveSubmittedResult({
      action: actionableAction,
      reason: 'live-order-submitted',
      audit: engineResult.audit,
      context,
      quote,
      executionPlan,
      orderIntent,
      broadcastResult,
      confirmationStatus: confirmation.status,
      journalPaths: journals.paths,
      killSwitchState
    }),
    confirmedFill
  }, lifecycleSynchronouslyResolved);
}
