import { join } from 'node:path';

import { loadStrategyConfig } from '../config/loader.ts';
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
  return Boolean(accountState?.walletTokens?.some((token) => token.amount > 0 && token.mint !== SOL_MINT && !STABLE_MINTS.has(token.mint)));
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
      score: firstNumber(context.pool.score, context.token.score, context.trader.score),
      unrealizedPct: typeof context.trader.unrealizedPct === 'number' ? context.trader.unrealizedPct : undefined,
      hasLpPosition: firstBoolean(context.trader.hasLpPosition),
      lpNetPnlPct: typeof context.trader.lpNetPnlPct === 'number' ? context.trader.lpNetPnlPct : undefined,
      lpImpermanentLossPct: typeof context.trader.lpImpermanentLossPct === 'number' ? context.trader.lpImpermanentLossPct : undefined,
      lpUnclaimedFeeUsd: typeof context.trader.lpUnclaimedFeeUsd === 'number' ? context.trader.lpUnclaimedFeeUsd : undefined,
      lpActiveBinStatus: context.trader.lpActiveBinStatus as any,
      lifecycleState: typeof context.trader.lifecycleState === 'string' ? context.trader.lifecycleState : undefined
    };
  }

  return {
    ...shared,
    score: firstNumber(context.pool.score, context.token.score, context.trader.score),
    feeTvlRatio: typeof context.pool.feeTvlRatio === 'number' ? context.pool.feeTvlRatio : undefined,
    fees24h: typeof context.pool.fees24h === 'number' ? context.pool.fees24h : undefined
  };
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

  if (!accountState && input.accountProvider) {
    accountState = await input.accountProvider.readState();
  }

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
  
  if (config.poolClass === 'new-token') {
    (snapshot as any).holdTimeMs = getHoldTimeMs(accountState, firstString(context.token.mint), Date.now());
  }

  const routeExists = Boolean(snapshot.hasSolRoute);
  const routeSlippageBps = firstNumber(context.route.slippageBps, config.solRouteLimits.maxSlippageBps);
  const tokenSymbol = firstString(context.token.symbol, context.route.token, context.token.mint);
  const poolAddress = firstString(context.pool.address, context.route.poolAddress, 'live-pool');
  const ingestBlockReason = firstString(context.route.blockReason, context.pool.blockReason, context.token.blockReason);
  const journals = createJournals(input.strategy, input.journalRootDir);
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

  if (ingestBlockReason) {
    logContext.engineReason = ingestBlockReason;
    await appendDecision(journals, logContext, {
      stage: 'engine',
      mode: 'BLOCKED',
      action: 'hold',
      reason: ingestBlockReason,
      liveOrderSubmitted: false
    });

    return buildBlockedCycleResult({
      action: 'hold',
      reason: ingestBlockReason,
      audit: { reason: ingestBlockReason },
      context,
      quoteCollected: false,
      journalPaths: journals.paths,
      killSwitchState
    });
  }

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

  const activeMint = firstString(logContext.tokenMint, context.token.mint);

  if (pendingSubmission) {
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
    if (preEngineMintAggregate.mustCleanupDust) {
      (updatedSnapshot as any).hasInventory = true;
      (updatedSnapshot as any).hasLpPosition = false;
      (updatedSnapshot as any).lifecycleState = 'inventory_exit_ready';
    }
  }
  const engineResult = runEngineCycle({
    engine: config.poolClass,
    snapshot: updatedSnapshot,
    config: {
      minScore: 70,
      minDeployScore: config.live.minDeployScore ?? 70,
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
      lpClaimFeeThresholdUsd: config.lpConfig?.claimFeeThresholdUsd,
      lpRebalanceOnOutOfRange: config.lpConfig?.rebalanceOnOutOfRange ?? false,
      lpMaxImpermanentLossPct: config.lpConfig?.maxImpermanentLossPct
    }
  });
  const engineAuditReason = [
    engineResult.audit.reason,
    `score=${updatedSnapshot.score ?? 'n/a'}`,
    `minDeployScore=${config.live.minDeployScore ?? 70}`,
    `lpEnabled=${config.lpConfig?.enabled ?? false}`,
    `hasLpPosition=${'hasLpPosition' in updatedSnapshot ? updatedSnapshot.hasLpPosition ?? false : false}`,
    `hasInventory=${'hasInventory' in updatedSnapshot ? updatedSnapshot.hasInventory ?? false : false}`,
    `lifecycleState=${'lifecycleState' in updatedSnapshot ? updatedSnapshot.lifecycleState ?? 'unknown' : 'n/a'}`
  ].join(' | ');
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
  const reopenCooldownMs = 1 * 60 * 60 * 1000;
  const isRecentlyClosedSameMint = Boolean(
    activeMint &&
    recentCloseMint === activeMint &&
    recentCloseAt &&
    (Date.now() - Date.parse(recentCloseAt)) < reopenCooldownMs
  );

  if (
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
    fullPositionExit: isFullPositionExitAction(actionableAction)
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

  if (input.confirmationProvider) {
    const polledConfirmation = await input.confirmationProvider.poll({
      submissionId: broadcastResult.submissionId,
      confirmationSignature: broadcastResult.confirmationSignature
    });
    const normalizedConfirmation = toConfirmationResult(polledConfirmation);

    confirmation = {
      status: normalizedConfirmation.status,
      submissionId: normalizedConfirmation.submissionId,
      reason: normalizedConfirmation.reason
    };
    confirmationFinality = normalizedConfirmation.finality;
    confirmationCheckedAt = normalizedConfirmation.checkedAt;
  }

  pendingSubmission = buildTrackedPendingSubmissionSnapshot({
    strategyId: input.strategy,
    idempotencyKey: orderIntent.idempotencyKey,
    submissionId: broadcastResult.submissionId,
    confirmationSignature: broadcastResult.confirmationSignature,
    confirmationStatus: confirmation.status,
    finality: confirmationFinality,
    createdAt: logContext.startedAt,
    updatedAt: confirmationCheckedAt,
    timeoutAt: buildPendingTimeoutAt(logContext.startedAt),
    tokenMint: logContext.tokenMint,
    tokenSymbol,
    orderAction: actionableAction,
    reason: confirmation.reason
  });
  await pendingSubmissionStore.write(pendingSubmission);

  if (isResolvedConfirmation(confirmation.status, confirmationFinality)) {
    await pendingSubmissionStore.clear();
    pendingSubmission = null;
  }

  if (
    spendingLimitsStore &&
    actionableActionClass === 'open_risk' &&
    isResolvedConfirmation(confirmation.status, confirmationFinality)
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
  await journals.fills.append({
    cycleId: logContext.cycleId,
    submissionId: broadcastResult.submissionId,
    strategyId: input.strategy,
    mint: logContext.tokenMint,
    symbol: tokenSymbol,
    side: actionableAction,
    filledSol: 0,
    status: 'submitted',
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
      filledSol: 0,
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
