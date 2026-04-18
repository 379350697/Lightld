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
import type { MirrorEventSink } from '../observability/mirror-events.ts';
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
import { TestLiveSigner, type LiveOrderIntent, type LiveSigner } from '../execution/live-signer.ts';
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
import { applyRuntimeActionPolicy } from './runtime-action-policy.ts';
import {
  classifyAction,
  type LiveAction
} from './action-semantics.ts';
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
  runAccountReconciliationGate,
  runPendingRecoveryGate
} from './live-cycle-preflight.ts';
import { isManageableLpPosition } from './lp-position-visibility.ts';
import { hasAnyWalletEvidenceForPendingSubmission } from './pending-submission-wallet-evidence.ts';
import type { RuntimeMode, PositionStateSnapshot, PositionLifecycleState } from './state-types.ts';

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

type LiveCycleJournals = {
  paths: LiveCycleJournalPaths;
  decisionAudit: DecisionAuditLog<Record<string, unknown>>;
  quotes: QuoteJournal<Record<string, unknown>>;
  orders: LiveOrderJournal<Record<string, unknown>>;
  fills: LiveFillJournal<Record<string, unknown>>;
  incidents: LiveIncidentJournal<Record<string, unknown>>;
};

type LiveFillEntry = NonNullable<LiveAccountState['fills']>[number];

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
  requestedPositionSol: number;
  quote?: SolExitQuote;
}) {
  if (!input.sink) {
    return;
  }

  try {
    await input.sink.appendOutcome({
      cycleId: input.logContext.cycleId,
      strategyId: input.logContext.strategyId,
      recordedAt: new Date().toISOString(),
      tokenMint: input.logContext.tokenMint,
      tokenSymbol: input.logContext.tokenSymbol,
      poolAddress: input.logContext.poolAddress,
      runtimeMode: input.logContext.runtimeMode,
      sessionPhase: input.logContext.sessionPhase,
      action: input.action,
      actualExitReason: input.actualExitReason,
      liveOrderSubmitted: input.liveOrderSubmitted,
      parameterSnapshot: buildEvolutionParameterSnapshot(input.config),
      exitMetrics: buildEvolutionExitMetrics({
        context: input.context,
        snapshot: input.snapshot,
        requestedPositionSol: input.requestedPositionSol,
        quote: input.quote
      })
    });
  } catch (error) {
    console.warn(
      `[LiveCycle] Evolution outcome persistence failed; continuing without research evidence: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function getHoldTimeMs(accountState: LiveAccountState | undefined, mint: string, nowMs: number): number {
  if (!accountState || !accountState.fills || !mint) return 0;
  
  const mintFills = accountState.fills
    .filter(f => f.mint === mint && (f.side === 'buy' || f.side === 'add-lp') && f.recordedAt)
    .sort((a, b) => Date.parse(a.recordedAt!) - Date.parse(b.recordedAt!));

  if (mintFills.length > 0) {
    const elapsed = nowMs - Date.parse(mintFills[0].recordedAt!);
    return elapsed > 0 ? elapsed : 0;
  }
  
  return 0;
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
    const mint = typeof entry.mint === 'string' ? entry.mint : '';
    const side = entry.side;
    const amount = typeof entry.amount === 'number' ? entry.amount : undefined;
    const recordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt : '';

    if (
      !mint ||
      !recordedAt ||
      typeof amount !== 'number' ||
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
      mint,
      symbol: typeof entry.symbol === 'string' ? entry.symbol : undefined,
      side,
      amount,
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
}) {
  return {
    hasSolRoute: true,
    liquidityUsd: 1,
    inSession: true,
    hasInventory: true,
    hasLpPosition: true,
    lpCurrentValueSol: input.position.currentValueSol,
    lpUnclaimedFeeSol: input.position.unclaimedFeeSol,
    lpSolDepletedBins: input.position.solDepletedBins,
    lpActiveBinStatus: typeof input.position.activeBinId === 'number'
      && typeof input.position.lowerBinId === 'number'
      && typeof input.position.upperBinId === 'number'
      ? (input.position.activeBinId >= input.position.lowerBinId && input.position.activeBinId <= input.position.upperBinId ? 'in-range' : 'out-of-range')
      : undefined,
    holdTimeMs: input.holdTimeMs,
    pendingConfirmationStatus: 'confirmed' as const,
    lifecycleState: 'open'
  };
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

function selectTriggeredLpExit(input: {
  accountState?: LiveAccountState;
  config: Awaited<ReturnType<typeof loadStrategyConfig>>;
  nowMs: number;
  fills: LiveFillEntry[];
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

    const openFill = input.fills
      ?.filter((fill) => fill.mint === mint && (fill.side === 'add-lp' || fill.side === 'buy') && fill.amount > 0)
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))[0];
    const entrySol = typeof openFill?.amount === 'number' && openFill.amount > 0 ? openFill.amount : undefined;
    const currentValueSol = typeof position.currentValueSol === 'number' ? position.currentValueSol : undefined;
    const unclaimedFeeSol = typeof position.unclaimedFeeSol === 'number' ? position.unclaimedFeeSol : 0;
    const holdTimeMs = openFill?.recordedAt ? Math.max(0, input.nowMs - Date.parse(openFill.recordedAt)) : 0;
    const snapshot: any = buildLpExitSnapshotFromPosition({ position, holdTimeMs });

    if (typeof entrySol === 'number' && typeof currentValueSol === 'number') {
      snapshot.lpNetPnlPct = evaluateLpPnl(entrySol, currentValueSol, unclaimedFeeSol, {
        stopLossNetPnlPct: input.config.lpConfig?.stopLossNetPnlPct ?? 20,
        takeProfitNetPnlPct: input.config.lpConfig?.takeProfitNetPnlPct ?? 30
      }).unrealizedPct;
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
      lpNetPnlPct: typeof context.trader.lpNetPnlPct === 'number' ? context.trader.lpNetPnlPct : undefined,
      lpCurrentValueSol: typeof context.trader.lpCurrentValueSol === 'number' ? context.trader.lpCurrentValueSol : undefined,
      lpUnclaimedFeeSol: typeof context.trader.lpUnclaimedFeeSol === 'number' ? context.trader.lpUnclaimedFeeSol : undefined,
      lpSolDepletedBins: typeof context.trader.lpSolDepletedBins === 'number' ? context.trader.lpSolDepletedBins : undefined,
      lpImpermanentLossPct: typeof context.trader.lpImpermanentLossPct === 'number' ? context.trader.lpImpermanentLossPct : undefined,
      lpUnclaimedFeeUsd: typeof context.trader.lpUnclaimedFeeUsd === 'number' ? context.trader.lpUnclaimedFeeUsd : undefined,
      lpActiveBinStatus: context.trader.lpActiveBinStatus as any,
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
  if (typeof input.context.trader.lpNetPnlPct === 'number') {
    return;
  }

  const contextMint = typeof input.context.token.mint === 'string' ? input.context.token.mint : '';
  const mintOpenFill = input.fills
    ?.filter((fill) => fill.mint === contextMint && (fill.side === 'add-lp' || fill.side === 'buy') && fill.amount > 0)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))[0];
  const liveFillEntrySol = typeof mintOpenFill?.amount === 'number' && mintOpenFill.amount > 0
    ? mintOpenFill.amount
    : undefined;
  const positionEntrySol = typeof input.positionState?.entrySol === 'number' && input.positionState.entrySol > 0
    ? input.positionState.entrySol
    : undefined;
  const requestedEntrySol = typeof input.requestedPositionSol === 'number' && input.requestedPositionSol > 0
    ? input.requestedPositionSol
    : undefined;
  const entrySol = liveFillEntrySol ?? positionEntrySol ?? requestedEntrySol;
  const currentValueSol = typeof input.context.trader.lpCurrentValueSol === 'number'
    ? input.context.trader.lpCurrentValueSol
    : undefined;
  const unclaimedFeeSol = typeof input.context.trader.lpUnclaimedFeeSol === 'number'
    ? input.context.trader.lpUnclaimedFeeSol
    : 0;

  if (typeof entrySol !== 'number' || typeof currentValueSol !== 'number') {
    return;
  }

  const result = evaluateLpPnl(entrySol, currentValueSol, unclaimedFeeSol, {
    stopLossNetPnlPct: input.config.lpConfig?.stopLossNetPnlPct ?? 20,
    takeProfitNetPnlPct: input.config.lpConfig?.takeProfitNetPnlPct ?? 30
  });

  input.context.trader.lpNetPnlPct = result.unrealizedPct;
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
  await journals.incidents.append({
    cycleId: logContext.cycleId,
    strategyId: logContext.strategyId,
    stage: entry.stage,
    severity: entry.severity,
    reason: entry.reason,
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
      incidentId: `${logContext.cycleId}:${entry.stage}:${recordedAt}`,
      cycleId: logContext.cycleId,
      stage: entry.stage,
      severity: entry.severity,
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

  const snapshot = buildEngineSnapshot(config.poolClass, context);
  maybePopulateLpNetPnlPct({
    context,
    positionState: input.positionState,
    config,
    requestedPositionSol: input.requestedPositionSol,
    fills: historicalFills
  });
  
  if (config.poolClass === 'new-token') {
    (snapshot as any).holdTimeMs = getHoldTimeMs(accountState, firstString(context.token.mint), Date.now());
  }

  const routeExists = Boolean(snapshot.hasSolRoute);
  const routeSlippageBps = firstNumber(context.route.slippageBps, config.solRouteLimits.maxSlippageBps);
  let tokenSymbol = firstString(context.token.symbol, context.route.token, context.token.mint);
  let poolAddress = firstString(context.pool.address, context.route.poolAddress, 'live-pool');
  const ingestBlockReason = firstString(context.route.blockReason, context.pool.blockReason, context.token.blockReason);
  const pendingSubmissionStore = new PendingSubmissionStore(
    resolveStateRootDir(input.strategy, input.stateRootDir)
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
    stage: 'live-config' | 'reconciliation' | 'guards' | 'broadcast' | 'recovery' | 'runtime-policy';
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
    (snapshot as any).pendingConfirmationStatus = pendingSubmission?.confirmationStatus;
  }

  const multiLpExit = config.poolClass === 'new-token'
    ? selectTriggeredLpExit({ accountState, config, nowMs: Date.now(), fills: historicalFills })
    : null;
  if (multiLpExit && multiLpExit.position.mint) {
    context.token.mint = multiLpExit.position.mint;
    context.pool.address = multiLpExit.position.poolAddress;
    context.token.symbol = firstString(context.token.symbol, multiLpExit.position.mint);
    context.trader.hasLpPosition = true;
    context.trader.hasInventory = true;
    context.trader.lpCurrentValueSol = multiLpExit.position.currentValueSol;
    context.trader.lpUnclaimedFeeSol = multiLpExit.position.unclaimedFeeSol;
    context.trader.lpSolDepletedBins = multiLpExit.position.solDepletedBins;
    context.trader.lpNetPnlPct = typeof multiLpExit.snapshot.lpNetPnlPct === 'number'
      ? multiLpExit.snapshot.lpNetPnlPct
      : context.trader.lpNetPnlPct;
    context.trader.lpActiveBinStatus = multiLpExit.snapshot.lpActiveBinStatus as
      | 'in-range'
      | 'out-of-range'
      | undefined;
  }

  const activeMint = firstString(multiLpExit?.position.mint, logContext.tokenMint, context.token.mint);
  if (multiLpExit?.position.poolAddress) {
    poolAddress = multiLpExit.position.poolAddress;
    tokenSymbol = firstString(context.token.symbol, logContext.tokenSymbol, multiLpExit.position.mint);
    logContext.poolAddress = poolAddress;
    logContext.tokenMint = multiLpExit.position.mint;
    logContext.tokenSymbol = tokenSymbol;
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
  if (config.poolClass === 'new-token') {
    (updatedSnapshot as any).holdTimeMs = (snapshot as any).holdTimeMs;
    (updatedSnapshot as any).pendingConfirmationStatus = (snapshot as any).pendingConfirmationStatus;
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
    await appendDecision(journals, logContext, {
      stage: 'engine',
      mode: 'BLOCKED',
      action: 'hold',
      reason: engineAuditReason,
      liveOrderSubmitted: false
    });

    return finalize(buildBlockedCycleResult({
      action: 'hold',
      reason: 'hold',
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
  const reopenCooldownMs = 50 * 60 * 1000;
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

  const quotedPositionSol = firstNumber(
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

  const requestedPositionSol = input.requestedPositionSol ?? quote.outputSol;
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

  const actionableAction = runtimeAction.action;

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

  const spendingLimitsStore = input.spendingLimitsConfig
    ? new SpendingLimitsStore(resolveStateRootDir(input.strategy, input.stateRootDir))
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
    maxDailySpendSol: input.spendingLimitsConfig?.maxDailySpendSol,
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
    liquidateResidualTokenToSol: actionableAction === 'withdraw-lp'
  });
  await journals.orders.append({
    cycleId: logContext.cycleId,
    ...orderIntent,
    requestedPositionSol,
    quotedOutputSol: quote.outputSol,
    routeExists: quote.routeExists
  });
  emitMirrorEvent(mirrorSink, () => {
    mirrorSink!.enqueue(toOrderMirrorEvent(buildOrderMirrorPayload({
      idempotencyKey: orderIntent.idempotencyKey,
      cycleId: logContext.cycleId,
      strategyId: input.strategy,
      poolAddress: executionPlan.poolAddress,
      tokenMint: logContext.tokenMint,
      tokenSymbol,
      action: actionableAction,
      requestedPositionSol,
      quotedOutputSol: quote.outputSol,
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      createdAt: logContext.startedAt,
      updatedAt: logContext.startedAt
    })));
  });

  const signedIntent = await signer.sign(orderIntent);
  let broadcastResult: LiveBroadcastResult;

  try {
    broadcastResult = await broadcaster.broadcast(signedIntent);
  } catch (error) {
    if (error instanceof ExecutionRequestError && error.kind === 'unknown') {
      const updatedAt = new Date().toISOString();
      pendingSubmission = buildUnknownPendingSubmissionSnapshot({
        strategyId: input.strategy,
        idempotencyKey: orderIntent.idempotencyKey,
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
      emitMirrorEvent(mirrorSink, () => {
        mirrorSink!.enqueue(toOrderMirrorEvent(buildOrderMirrorPayload({
          idempotencyKey: orderIntent.idempotencyKey,
          cycleId: logContext.cycleId,
          strategyId: input.strategy,
          poolAddress: executionPlan.poolAddress,
          tokenMint: logContext.tokenMint,
          tokenSymbol,
          action: actionableAction,
          requestedPositionSol,
          quotedOutputSol: quote.outputSol,
          broadcastStatus: 'unknown',
          confirmationStatus: 'unknown',
          finality: 'unknown',
          createdAt: logContext.startedAt,
          updatedAt
        })));
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

    throw error;
  }

  if (broadcastResult.status !== 'submitted') {
    const confirmation = trackConfirmation({
      submissionId: undefined,
      failureReason: broadcastResult.reason
    });
    emitMirrorEvent(mirrorSink, () => {
      mirrorSink!.enqueue(toOrderMirrorEvent(buildOrderMirrorPayload({
        idempotencyKey: orderIntent.idempotencyKey,
        cycleId: logContext.cycleId,
        strategyId: input.strategy,
        submissionId: '',
        confirmationSignature: '',
        poolAddress: executionPlan.poolAddress,
        tokenMint: logContext.tokenMint,
        tokenSymbol,
        action: actionableAction,
        requestedPositionSol,
        quotedOutputSol: quote.outputSol,
        broadcastStatus: 'failed',
        confirmationStatus: confirmation.status,
        finality: 'unknown',
        createdAt: logContext.startedAt,
        updatedAt: new Date().toISOString()
      })));
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
    await spendingLimitsStore.recordSpend(requestedPositionSol);
  }
  emitMirrorEvent(mirrorSink, () => {
    mirrorSink!.enqueue(toOrderMirrorEvent(buildOrderMirrorPayload({
      idempotencyKey: orderIntent.idempotencyKey,
      cycleId: logContext.cycleId,
      strategyId: input.strategy,
      submissionId: broadcastResult.submissionId,
      confirmationSignature: broadcastResult.confirmationSignature,
      poolAddress: executionPlan.poolAddress,
      tokenMint: logContext.tokenMint,
      tokenSymbol,
      action: actionableAction,
      requestedPositionSol,
      quotedOutputSol: quote.outputSol,
      broadcastStatus: 'submitted',
      confirmationStatus: confirmation.status,
      finality: confirmationFinality,
      createdAt: logContext.startedAt,
      updatedAt: confirmationCheckedAt
    })));
  });

  const fillRecordedAt = new Date().toISOString();
  const isConfirmedFill = isResolvedConfirmation(confirmation.status, confirmationFinality);
  const mirroredFilledSol = isConfirmedFill ? requestedPositionSol : 0;
  const mirroredFillStatus = isConfirmedFill ? 'confirmed' : 'submitted';
  await journals.fills.append({
    cycleId: logContext.cycleId,
    submissionId: broadcastResult.submissionId,
    strategyId: input.strategy,
    mint: logContext.tokenMint,
    symbol: tokenSymbol,
    side: actionableAction,
    filledSol: mirroredFilledSol,
    status: mirroredFillStatus,
    confirmationStatus: confirmation.status,
    requestedPositionSol,
    recordedAt: fillRecordedAt
  });
  emitMirrorEvent(mirrorSink, () => {
    mirrorSink!.enqueue(toFillMirrorEvent({
      fillId: `${broadcastResult.submissionId}:${fillRecordedAt}`,
      submissionId: broadcastResult.submissionId,
      confirmationSignature: broadcastResult.confirmationSignature ?? '',
      cycleId: logContext.cycleId,
      tokenMint: logContext.tokenMint,
      tokenSymbol,
      side: resolveFillMirrorSide(actionableAction),
      amount: 0,
      filledSol: mirroredFilledSol,
      recordedAt: fillRecordedAt
    }));
  });
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

  await appendEvolutionOutcomeBestEffort({
    sink: input.evolutionSink,
    logContext,
    action: actionableAction,
    actualExitReason: engineResult.audit.reason,
    liveOrderSubmitted: true,
    config,
    context,
    snapshot: updatedSnapshot,
    requestedPositionSol,
    quote
  });

  return finalize(buildLiveSubmittedResult({
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
  }), isResolvedConfirmation(confirmation.status, confirmationFinality));
}
