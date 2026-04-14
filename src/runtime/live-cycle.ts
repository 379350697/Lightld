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
import { buildExecutionPlan } from '../execution/build-execution-plan.ts';
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
import { evaluateLiveGuards } from '../risk/live-guards.ts';
import type { SpendingLimitsConfig } from '../risk/spending-limits.ts';
import { SpendingLimitsStore } from '../risk/spending-limits.ts';
import { runEngineCycle } from '../strategy/engine-runner.ts';
import { buildDecisionContext, type DecisionContextInput } from './build-decision-context.ts';
import { KillSwitch } from './kill-switch.ts';
import type { LiveAccountState, LiveAccountStateProvider } from './live-account-provider.ts';
import { PendingSubmissionStore } from './pending-submission-store.ts';
import { recoverPendingSubmission } from './pending-submission-recovery.ts';
import { reconcileLiveState } from './reconcile-live-state.ts';
import { applyRuntimeActionPolicy } from './runtime-action-policy.ts';
import type { RuntimeMode, PositionStateSnapshot, PositionLifecycleState } from './state-types.ts';
import { toPendingConfirmationStatus } from './state-types.ts';

const STRATEGY_CONFIGS = {
  'new-token-v1': 'src/config/strategies/new-token-v1.yaml',
  'large-pool-v1': 'src/config/strategies/large-pool-v1.yaml'
} as const;

export type StrategyId = keyof typeof STRATEGY_CONFIGS;

export type LiveCycleInput = {
  strategy: StrategyId;
  context?: DecisionContextInput;
  killSwitch?: KillSwitch;
  whitelist?: string[];
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
  action: 'hold' | 'deploy' | 'dca-out' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';
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

const PENDING_SUBMISSION_TIMEOUT_MS = 2 * 60_000;

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
    .filter(f => f.mint === mint && f.side === 'buy' && f.recordedAt)
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
  return {
    decisionAuditPath: join(journalRootDir, `${strategyId}-decision-audit.jsonl`),
    quoteJournalPath: join(journalRootDir, `${strategyId}-quotes.jsonl`),
    liveOrderPath: join(journalRootDir, `${strategyId}-live-orders.jsonl`),
    liveFillPath: join(journalRootDir, `${strategyId}-live-fills.jsonl`),
    liveIncidentPath: join(journalRootDir, `${strategyId}-live-incidents.jsonl`)
  };
}

function createJournals(strategyId: StrategyId, journalRootDir?: string): LiveCycleJournals {
  const paths = createJournalPaths(strategyId, journalRootDir);

  return {
    paths,
    decisionAudit: new DecisionAuditLog(paths.decisionAuditPath),
    quotes: new QuoteJournal(paths.quoteJournalPath),
    orders: new LiveOrderJournal(paths.liveOrderPath),
    fills: new LiveFillJournal(paths.liveFillPath),
    incidents: new LiveIncidentJournal(paths.liveIncidentPath)
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

function buildPendingTimeoutAt(startedAt: string) {
  return new Date(Date.parse(startedAt) + PENDING_SUBMISSION_TIMEOUT_MS).toISOString();
}

function isResolvedConfirmation(status: ConfirmationStatus, finality?: ConfirmationFinality) {
  if (status === 'failed') {
    return true;
  }

  return status === 'confirmed' && (finality === 'confirmed' || finality === 'finalized');
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
  let currentLifecycleState: PositionLifecycleState = input.positionState?.lifecycleState ?? 'open';
  const config = await loadStrategyConfig(STRATEGY_CONFIGS[input.strategy]);
  const context = buildDecisionContext(input.context ?? {});
  const mirrorSink = input.mirrorSink;
  const killSwitch = input.killSwitch ?? new KillSwitch(false);
  const killSwitchState = killSwitch.isEngaged();
  const quoteProvider = input.quoteProvider ?? new StaticLiveQuoteProvider();
  const signer = input.signer ?? new TestLiveSigner();
  const broadcaster = input.broadcaster ?? new TestLiveBroadcaster();
  let accountState = input.accountState;
  
  if (!accountState && input.accountProvider) {
    accountState = await input.accountProvider.readState();
  }

  const snapshot = buildEngineSnapshot(config.poolClass, context);
  
  if (config.poolClass === 'new-token') {
    (snapshot as any).holdTimeMs = getHoldTimeMs(accountState, firstString(context.token.mint), Date.now());
  }

  const routeExists = Boolean(snapshot.hasSolRoute);
  const routeSlippageBps = firstNumber(context.route.slippageBps, config.solRouteLimits.maxSlippageBps);
  const tokenSymbol = firstString(context.token.symbol, context.route.token, context.token.mint);
  const poolAddress = firstString(context.pool.address, context.route.poolAddress, 'live-pool');
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

  let reconciliationOk = (input.reconciliationStatus ?? 'matched') === 'matched';
  let currentRequestedPositionSol = input.requestedPositionSol ?? 0;

  context.trader.lifecycleState = currentLifecycleState;

  const finalize = (result: Omit<LiveCycleResult, 'nextLifecycleState'>, synchronouslyResolved?: boolean): LiveCycleResult => {
    let nextLifecycleState = currentLifecycleState;
    if (result.liveOrderSubmitted) {
      if (result.action === 'withdraw-lp') {
        nextLifecycleState = synchronouslyResolved ? 'inventory_exit_ready' : 'lp_exit_pending';
      }
      if (result.action === 'dca-out') {
        nextLifecycleState = synchronouslyResolved ? 'closed' : 'inventory_exit_pending';
      }
      if (result.action === 'deploy' || result.action === 'add-lp') {
        nextLifecycleState = 'open';
      }
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
  const pendingSubmission = await pendingSubmissionStore.read();

  if (pendingSubmission) {
    const recovery = await recoverPendingSubmission({
      pendingSubmission,
      confirmationProvider: input.confirmationProvider,
      accountState
    });
    console.log('!!! RECOVERY !!!', recovery);

    if (recovery.clearPending) {
      await pendingSubmissionStore.clear();

      if (recovery.reason === 'pending-submission-confirmed' || recovery.reason === 'pending-submission-filled') {
        if (currentLifecycleState === 'lp_exit_pending') {
          currentLifecycleState = 'inventory_exit_ready';
        } else if (currentLifecycleState === 'inventory_exit_pending') {
          currentLifecycleState = 'closed';
        }
      } else if (recovery.reason === 'pending-submission-failed') {
        if (currentLifecycleState === 'lp_exit_pending' || currentLifecycleState === 'inventory_exit_pending') {
          currentLifecycleState = 'open';
        }
      }
      // Update context trader state after recovery state changes
      context.trader.lifecycleState = currentLifecycleState;
    } else if (recovery.nextPendingSubmission) {
      await pendingSubmissionStore.write(recovery.nextPendingSubmission);
    }

    if (recovery.blocked) {
      await appendDecision(journals, logContext, {
        stage: 'recovery',
        mode: 'BLOCKED',
        action: 'hold',
        reason: recovery.reason,
        liveOrderSubmitted: false
      });
      await appendIncident(journals, logContext, mirrorSink, {
        stage: 'recovery',
        reason: recovery.reason,
        severity: recovery.reason === 'pending-submission-timeout' ? 'error' : 'warning'
      });

      return finalize({
        status: 'ok',
        mode: 'BLOCKED',
        action: 'hold',
        reason: recovery.reason,
        audit: { reason: recovery.reason },
        context,
        failureKind: recovery.reason === 'pending-submission-timeout' ? 'unknown' : undefined,
        failureSource: 'recovery',
        journalPaths: journals.paths,
        killSwitchState,
        liveOrderSubmitted: false,
        quoteCollected: false
      });
    }
  }

  const updatedSnapshot = buildEngineSnapshot(config.poolClass, context);
  if (config.poolClass === 'new-token') {
    (updatedSnapshot as any).holdTimeMs = (snapshot as any).holdTimeMs;
  }
  const engineResult = runEngineCycle({
    engine: config.poolClass,
    snapshot: updatedSnapshot,
    config: {
      minScore: 70,
      minDeployScore: config.live.minDeployScore ?? 70,
      requireSolRoute: config.hardGates.requireSolRoute,
      minLiquidityUsd: config.hardGates.minLiquidityUsd,
      minPoolAgeMinutes: config.hardGates.minPoolAgeMinutes,
      maxPoolAgeMinutes: config.hardGates.maxPoolAgeMinutes,
      takeProfitPct: config.riskThresholds.takeProfitPct,
      stopLossPct: config.riskThresholds.stopLossPct,
      lpEnabled: config.lpConfig?.enabled ?? false,
      lpStopLossNetPnlPct: config.lpConfig?.stopLossNetPnlPct,
      lpTakeProfitNetPnlPct: config.lpConfig?.takeProfitNetPnlPct
    }
  });
  logContext.engineReason = engineResult.audit.reason;

  if (engineResult.action === 'hold') {
    await appendDecision(journals, logContext, {
      stage: 'engine',
      mode: 'BLOCKED',
      action: 'hold',
      reason: engineResult.audit.reason,
      liveOrderSubmitted: false
    });

    return finalize({
      status: 'ok',
      mode: 'BLOCKED',
      action: 'hold',
      reason: 'hold',
      audit: engineResult.audit,
      context,
      quoteCollected: false,
      liveOrderSubmitted: false,
      journalPaths: journals.paths,
      killSwitchState
    });
  }

  const runtimeAction = applyRuntimeActionPolicy({
    mode: runtimeMode,
    action: engineResult.action
  });

  if (runtimeAction.action === 'hold' && runtimeAction.blockedReason) {
    await appendDecision(journals, logContext, {
      stage: 'runtime-policy',
      mode: 'BLOCKED',
      action: 'hold',
      reason: runtimeAction.blockedReason,
      liveOrderSubmitted: false
    });

    return finalize({
      status: 'ok',
      mode: 'BLOCKED',
      action: 'hold',
      reason: runtimeAction.blockedReason,
      audit: engineResult.audit,
      context,
      quoteCollected: false,
      liveOrderSubmitted: false,
      failureSource: 'runtime-policy',
      journalPaths: journals.paths,
      killSwitchState
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

  const executionPlan = buildExecutionPlan({
    strategyId: input.strategy,
    targetPool: poolAddress,
    quote
  });

  const actionableAction = runtimeAction.action;

  if (!config.live.enabled) {
    await appendDecision(journals, logContext, {
      stage: 'live-config',
      mode: 'BLOCKED',
      action: actionableAction,
      reason: 'strategy-live-disabled',
      requestedPositionSol,
      quote,
      liveOrderSubmitted: false
    });
    await appendIncident(journals, logContext, mirrorSink, {
      stage: 'live-config',
      reason: 'strategy-live-disabled',
      severity: 'warning',
      requestedPositionSol,
      quote
    });

    return finalize({
      status: 'ok',
      mode: 'BLOCKED',
      action: actionableAction,
      reason: 'strategy-live-disabled',
      audit: engineResult.audit,
      context,
      quoteCollected: true,
      quote,
      executionPlan,
      liveOrderSubmitted: false,
      journalPaths: journals.paths,
      killSwitchState
    });
  }

  if ((input.reconciliationStatus ?? 'matched') !== 'matched') {
    reconciliationOk = false;
    await appendDecision(journals, logContext, {
      stage: 'reconciliation',
      mode: 'BLOCKED',
      action: actionableAction,
      reason: 'reconciliation-required',
      requestedPositionSol,
      quote,
      liveOrderSubmitted: false
    });
    await appendIncident(journals, logContext, mirrorSink, {
      stage: 'reconciliation',
      reason: 'reconciliation-required',
      severity: 'warning',
      requestedPositionSol,
      quote
    });

    return finalize({
      status: 'ok',
      mode: 'BLOCKED',
      action: actionableAction,
      reason: 'reconciliation-required',
      audit: engineResult.audit,
      context,
      quoteCollected: true,
      quote,
      executionPlan,
      liveOrderSubmitted: false,
      journalPaths: journals.paths,
      killSwitchState
    });
  }

  if (accountState || input.accountProvider) {
    const reconciliation = reconcileLiveState(accountState!);
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
      await appendDecision(journals, logContext, {
        stage: 'reconciliation',
        mode: 'BLOCKED',
        action: actionableAction,
        reason: reconciliation.reason,
        requestedPositionSol,
        quote,
        reconciliationDeltaSol: reconciliation.deltaSol,
        liveOrderSubmitted: false
      });
      await appendIncident(journals, logContext, mirrorSink, {
        stage: 'reconciliation',
        reason: reconciliation.reason,
        severity: 'warning',
        requestedPositionSol,
        quote,
        reconciliationDeltaSol: reconciliation.deltaSol
      });

      return finalize({
        status: 'ok',
        mode: 'BLOCKED',
        action: actionableAction,
        reason: reconciliation.reason,
        audit: engineResult.audit,
        context,
        quoteCollected: true,
        quote,
        executionPlan,
        liveOrderSubmitted: false,
        journalPaths: journals.paths,
        killSwitchState
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
    symbol: tokenSymbol,
    whitelist: input.whitelist ?? [],
    requestedPositionSol,
    maxLivePositionSol: config.live.maxLivePositionSol,
    killSwitchEngaged: killSwitchState,
    requireWhitelist: config.live.requireWhitelist,
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

  if (!guardResult.allowed) {
    await appendDecision(journals, logContext, {
      stage: 'guards',
      mode: 'BLOCKED',
      action: actionableAction,
      reason: guardResult.reason,
      requestedPositionSol,
      quote,
      liveOrderSubmitted: false
    });
    await appendIncident(journals, logContext, mirrorSink, {
      stage: 'guards',
      reason: guardResult.reason,
      severity: 'warning',
      requestedPositionSol,
      quote
    });

    return finalize({
      status: 'ok',
      mode: 'BLOCKED',
      action: actionableAction,
      reason: guardResult.reason,
      audit: engineResult.audit,
      context,
      quoteCollected: true,
      quote,
      executionPlan,
      liveOrderSubmitted: false,
      journalPaths: journals.paths,
      killSwitchState
    });
  }

  const orderIntent = buildOrderIntent({
    strategyId: input.strategy,
    poolAddress: executionPlan.poolAddress,
    outputSol: requestedPositionSol,
    side: actionableAction === 'deploy' ? 'buy' 
      : actionableAction === 'dca-out' || actionableAction === 'hold' ? 'sell'
      : actionableAction,
    tokenMint: logContext.tokenMint
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
      await pendingSubmissionStore.write({
        strategyId: input.strategy,
        idempotencyKey: orderIntent.idempotencyKey,
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: logContext.startedAt,
        updatedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        timeoutAt: buildPendingTimeoutAt(logContext.startedAt),
        tokenMint: logContext.tokenMint,
        tokenSymbol,
        reason: error.reason
      });
      await appendDecision(journals, logContext, {
        stage: 'broadcast',
        mode: 'BLOCKED',
        action: actionableAction,
        reason: error.reason,
        requestedPositionSol,
        quote,
        confirmationStatus: 'unknown',
        liveOrderSubmitted: false
      });
      await appendIncident(journals, logContext, mirrorSink, {
        stage: 'broadcast',
        reason: error.reason,
        severity: 'error',
        requestedPositionSol,
        quote
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
          broadcastStatus: 'unknown',
          confirmationStatus: 'unknown',
          finality: 'unknown',
          createdAt: logContext.startedAt,
          updatedAt: new Date().toISOString()
        })));
      });

      return finalize({
        status: 'ok',
        mode: 'BLOCKED',
        action: actionableAction,
        reason: error.reason,
        audit: engineResult.audit,
        context,
        quoteCollected: true,
        quote,
        executionPlan,
        liveOrderSubmitted: false,
        orderIntent,
        confirmationStatus: 'unknown',
        failureKind: error.kind,
        failureSource: 'broadcast',
        journalPaths: journals.paths,
        killSwitchState
      });
    }

    throw error;
  }

  if (broadcastResult.status !== 'submitted') {
    const confirmation = trackConfirmation({
      submissionId: undefined,
      failureReason: broadcastResult.reason
    });
    await appendDecision(journals, logContext, {
      stage: 'broadcast',
      mode: 'BLOCKED',
      action: actionableAction,
      reason: broadcastResult.reason,
      requestedPositionSol,
      quote,
      confirmationStatus: confirmation.status,
      liveOrderSubmitted: false
    });
    await appendIncident(journals, logContext, mirrorSink, {
      stage: 'broadcast',
      reason: broadcastResult.reason,
      severity: 'error',
      requestedPositionSol,
      quote
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

    return finalize({
      status: 'ok',
      mode: 'BLOCKED',
      action: actionableAction,
      reason: broadcastResult.reason,
      audit: engineResult.audit,
      context,
      quoteCollected: true,
      quote,
      executionPlan,
      liveOrderSubmitted: false,
      orderIntent,
      broadcastResult,
      confirmationStatus: confirmation.status,
      failureSource: 'broadcast',
      journalPaths: journals.paths,
      killSwitchState
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

  await pendingSubmissionStore.write({
    strategyId: input.strategy,
    idempotencyKey: orderIntent.idempotencyKey,
    submissionId: broadcastResult.submissionId,
    confirmationSignature: broadcastResult.confirmationSignature,
    confirmationStatus: toPendingConfirmationStatus(confirmation.status),
    finality: confirmationFinality,
    createdAt: logContext.startedAt,
    updatedAt: confirmationCheckedAt,
    lastCheckedAt: confirmationCheckedAt,
    timeoutAt: buildPendingTimeoutAt(logContext.startedAt),
    tokenMint: logContext.tokenMint,
    tokenSymbol,
    reason: confirmation.reason
  });

  if (isResolvedConfirmation(confirmation.status, confirmationFinality)) {
    await pendingSubmissionStore.clear();
  }

  if (spendingLimitsStore) {
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
      side: actionableAction === 'deploy' ? 'buy' : actionableAction === 'dca-out' ? 'sell' : 'unknown',
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

  return finalize({
    status: 'ok',
    mode: 'LIVE',
    action: actionableAction,
    reason: 'live-order-submitted',
    audit: engineResult.audit,
    context,
    quoteCollected: true,
    quote,
    executionPlan,
    liveOrderSubmitted: true,
    orderIntent,
    broadcastResult,
    confirmationStatus: confirmation.status,
    journalPaths: journals.paths,
    killSwitchState
  }, isResolvedConfirmation(confirmation.status, confirmationFinality));
}
