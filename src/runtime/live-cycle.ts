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
  isDefinitelyNotSubmittedBroadcastError,
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
import { isSolanaTransactionSignature } from '../shared/solana-signature.ts';
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
import { buildLpExitPolicyDecision, type LpExitPolicyConfig } from '../strategy/lp-exit-policy.ts';
import { buildDecisionContext, type DecisionContextInput } from './build-decision-context.ts';
import { KillSwitch } from './kill-switch.ts';
import type { LiveAccountState, LiveAccountStateProvider } from './live-account-provider.ts';
import { PendingSubmissionStore } from './pending-submission-store.ts';
import {
  PreparedBroadcastStore,
  buildPreparedBroadcastSnapshot,
  recoverPreparedBroadcast
} from './prepared-broadcast-store.ts';
import { TargetOpenCooldownStore } from './target-open-cooldown-store.ts';
import { RECENTLY_CLOSED_MINT_REOPEN_COOLDOWN_MS } from './ingest-candidate-selection.ts';
import { applyRuntimeActionPolicy } from './runtime-action-policy.ts';
import {
  classifyAction,
  isFullExitAction,
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
import { evaluateLpRiskSentinel } from './lp-risk-sentinel.ts';
import {
  hasAnyWalletEvidenceForPendingSubmission,
  hasCompleteFreshAccountSnapshot,
  hasFreshCompleteLpExitAbsenceEvidence
} from './pending-submission-wallet-evidence.ts';
import { hasActionableTokenAmount } from './token-inventory.ts';
import {
  classifyLpEntryFillBinding,
  isTrustedFillAmountSource,
  isTrustedEntrySolSource,
  isTrustedLpOpenFill,
  resolveTrustedLpEntry
} from './lp-entry-resolver.ts';
import {
  hasLightldLpOwnershipEvidence,
  positionStateOwnsLpPosition
} from './lp-ownership.ts';
import type {
  RuntimeMode,
  PositionStateSnapshot,
  PositionLedgerSnapshot,
  PositionLedgerRecord,
  LpRiskSentinelSnapshot,
  PositionLifecycleState,
  PendingSubmissionSnapshot,
  PendingFinality
} from './state-types.ts';

const STRATEGY_CONFIGS = {
  'new-token-v1': 'src/config/strategies/new-token-v1.yaml',
  'large-pool-v1': 'src/config/strategies/large-pool-v1.yaml'
} as const;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);

function sumWalletTokenAmountRaw(
  accountState: LiveAccountState | undefined,
  tokenMint: string
) {
  if (!accountState || !tokenMint) {
    return undefined;
  }

  let total = 0n;
  for (const token of accountState.walletTokens ?? []) {
    if (token.mint !== tokenMint) {
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

  return total.toString();
}

function sumOwnedResidualAmountRaw(
  ledger: PositionLedgerSnapshot | undefined,
  tokenMint: string
) {
  let total = 0n;
  let found = false;
  for (const record of ledger?.records ?? []) {
    if (
      record.activeMint !== tokenMint
      || record.residualCleanupStatus !== 'residual_cleanup_pending'
      || !record.residualCleanupAmountRaw
      || !/^\d+$/.test(record.residualCleanupAmountRaw)
    ) {
      continue;
    }
    total += BigInt(record.residualCleanupAmountRaw);
    found = true;
  }
  return found && total > 0n ? total.toString() : undefined;
}

function hasStrategyOwnedInventory(input: {
  accountState: LiveAccountState | undefined;
  activeMint?: string;
  activePoolAddress?: string;
}) {
  if (!input.activeMint) {
    return false;
  }

  return Boolean(
    input.accountState?.walletTokens?.some((token) =>
      hasActionableTokenAmount(token) && token.mint === input.activeMint
    ) ||
    input.accountState?.walletLpPositions?.some((position) =>
      position.mint === input.activeMint
      && (!input.activePoolAddress || position.poolAddress === input.activePoolAddress)
      && isManageableLpPosition(position)
    ) ||
    input.accountState?.journalLpPositions?.some((position) =>
      position.mint === input.activeMint
      && (!input.activePoolAddress || position.poolAddress === input.activePoolAddress)
      && isManageableLpPosition(position)
    )
  );
}

function findWalletTokenInventory(input: {
  accountState: LiveAccountState | undefined;
  activeMint?: string;
}) {
  if (!input.activeMint || input.activeMint === SOL_MINT || STABLE_MINTS.has(input.activeMint)) {
    return undefined;
  }

  const matches = (input.accountState?.walletTokens ?? [])
    .filter((token) => token.mint === input.activeMint && hasActionableTokenAmount(token));
  if (matches.length === 0) {
    return undefined;
  }
  const currentValues = matches.map((token) => token.currentValueSol);
  return {
    ...matches[0],
    amount: matches.reduce((total, token) => total + token.amount, 0),
    currentValueSol: currentValues.every((value) => typeof value === 'number' && Number.isFinite(value))
      ? currentValues.reduce<number>((total, value) => total + (value ?? 0), 0)
      : undefined
  };
}

function resolveOwnedSpotInventory(input: {
  accountState: LiveAccountState | undefined;
  activeMint?: string;
  ownedTokenAmountRaw?: string;
}) {
  const walletInventory = findWalletTokenInventory(input);
  if (!input.activeMint || !walletInventory) {
    return {
      walletInventory,
      ownedInventory: undefined,
      reconcileReason: input.activeMint
        ? input.ownedTokenAmountRaw
          ? 'spot-ownership-reconcile-required:owned-token-not-in-wallet'
          : 'spot-ownership-reconcile-required:owned-token-amount-missing'
        : undefined
    };
  }

  if (!input.ownedTokenAmountRaw || !/^\d+$/.test(input.ownedTokenAmountRaw) || BigInt(input.ownedTokenAmountRaw) <= 0n) {
    return {
      walletInventory,
      ownedInventory: undefined,
      reconcileReason: 'spot-ownership-reconcile-required:owned-token-amount-missing'
    };
  }

  const walletAmountRaw = sumWalletTokenAmountRaw(input.accountState, input.activeMint);
  if (!walletAmountRaw || !/^\d+$/.test(walletAmountRaw) || BigInt(walletAmountRaw) <= 0n) {
    return {
      walletInventory,
      ownedInventory: undefined,
      reconcileReason: 'spot-ownership-reconcile-required:wallet-token-raw-unavailable'
    };
  }

  const ownedRaw = BigInt(input.ownedTokenAmountRaw);
  const walletRaw = BigInt(walletAmountRaw);
  if (ownedRaw > walletRaw) {
    return {
      walletInventory,
      ownedInventory: undefined,
      reconcileReason: 'spot-ownership-reconcile-required:wallet-balance-below-owned-amount'
    };
  }

  const ratio = Number((ownedRaw * 1_000_000_000n) / walletRaw) / 1_000_000_000;
  return {
    walletInventory,
    ownedInventory: {
      ...walletInventory,
      amount: walletInventory.amount * ratio,
      amountLamports: ownedRaw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(ownedRaw) : undefined,
      amountRaw: ownedRaw.toString(),
      currentValueSol: typeof walletInventory.currentValueSol === 'number'
        ? walletInventory.currentValueSol * ratio
        : undefined
    },
    reconcileReason: undefined
  };
}


export type StrategyId = keyof typeof STRATEGY_CONFIGS;

export type LiveCycleInput = {
  strategy: StrategyId;
  context?: DecisionContextInput;
  killSwitch?: KillSwitch;
  requestedPositionSol?: number;
  journalRootDir?: string;
  stateRootDir?: string;
  captureMode?: 'live' | 'mechanical-soak' | 'economic-shadow';
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
  positionLedger?: PositionLedgerSnapshot;
  deferResolvedPendingClear?: boolean;
  residualTokenSweepMinValueSol?: number;
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
  actionIdentity?: {
    openIntentId?: string;
    positionId?: string;
    chainPositionAddress?: string;
  };
  broadcastResult?: LiveBroadcastResult;
  confirmationStatus?: ConfirmationStatus;
  confirmedFill?: LiveCycleConfirmedFill;
  /** True only after authoritative post-submit evidence proves the submitted exit leg itself is resolved. */
  submittedActionClosureProven?: boolean;
  /** True only after authoritative post-submit evidence proves the strategy-owned position is fully closed. */
  fullExitClosureProven?: boolean;
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
  acquiredTokenAmountRaw?: string;
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
  acquiredTokenAmountRaw?: string;
  disposedTokenAmountRaw?: string;
  postAccountState?: LiveAccountState;
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
  captureMode?: 'live' | 'mechanical-soak' | 'economic-shadow';
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

function firstOptionalNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstPositiveNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'number' && value > 0) {
      return value;
    }
  }

  return undefined;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return '';
}

function firstValuationCompleteness(...values: unknown[]): 'complete' | 'incomplete' | 'untrusted' | undefined {
  const value = firstString(...values);
  return value === 'complete' || value === 'incomplete' || value === 'untrusted'
    ? value
    : undefined;
}

function firstValuationTrust(...values: unknown[]): 'exit_quote' | 'market_price' | 'fallback_display' | undefined {
  const value = firstString(...values);
  return value === 'exit_quote' || value === 'market_price' || value === 'fallback_display'
    ? value
    : undefined;
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

function buildStrategyLpExitPolicyConfig(
  config: Awaited<ReturnType<typeof loadStrategyConfig>>
): LpExitPolicyConfig {
  return {
    maxHoldHours: config.live.maxHoldHours ?? 18,
    lpStopLossNetPnlPct: config.lpConfig?.stopLossNetPnlPct,
    lpTakeProfitNetPnlPct: config.lpConfig?.takeProfitNetPnlPct,
    lpMinHoldMinutesBeforeTakeProfit: 5,
    lpSolDepletionExitBins: config.lpConfig?.solDepletionExitBins,
    lpClaimFeeThresholdUsd: config.lpConfig?.claimFeeThresholdUsd,
    lpRebalanceOnOutOfRange: config.lpConfig?.rebalanceOnOutOfRange ?? false,
    lpMaxImpermanentLossPct: config.lpConfig?.maxImpermanentLossPct
  };
}

function buildEvolutionExitMetrics(input: {
  context: ReturnType<typeof buildDecisionContext>;
  snapshot: Record<string, unknown>;
  requestedPositionSol: number;
  quote?: SolExitQuote;
  settlementEvidence?: LiveCycleOutcomeRecord['exitMetrics']['settlementEvidence'];
}) {
  return {
    requestedPositionSol: input.requestedPositionSol,
    quoteOutputSol: input.quote?.outputSol,
    holdTimeMs: typeof input.snapshot.holdTimeMs === 'number' ? input.snapshot.holdTimeMs : undefined,
    lpNetPnlPct: typeof input.context.trader.lpNetPnlPct === 'number' ? input.context.trader.lpNetPnlPct : undefined,
    lpSolDepletedBins: typeof input.context.trader.lpSolDepletedBins === 'number' ? input.context.trader.lpSolDepletedBins : undefined,
    lpCurrentValueSol: typeof input.context.trader.lpCurrentValueSol === 'number' ? input.context.trader.lpCurrentValueSol : undefined,
    lpLiquidityValueSol: typeof input.context.trader.lpLiquidityValueSol === 'number' ? input.context.trader.lpLiquidityValueSol : undefined,
    lpTotalValueSol: typeof input.context.trader.lpTotalValueSol === 'number' ? input.context.trader.lpTotalValueSol : undefined,
    exitQuoteValueSol: typeof input.context.trader.exitQuoteValueSol === 'number' ? input.context.trader.exitQuoteValueSol : undefined,
    lpUnclaimedFeeSol: typeof input.context.trader.lpUnclaimedFeeSol === 'number' ? input.context.trader.lpUnclaimedFeeSol : undefined,
    lpUnclaimedFeeValueSol: typeof input.context.trader.lpUnclaimedFeeValueSol === 'number' ? input.context.trader.lpUnclaimedFeeValueSol : undefined,
    lpClaimedFeeValueSol: typeof input.context.trader.lpClaimedFeeValueSol === 'number' ? input.context.trader.lpClaimedFeeValueSol : undefined,
    lpRecoverableRentSol: typeof input.context.trader.lpRecoverableRentSol === 'number' ? input.context.trader.lpRecoverableRentSol : undefined,
    lpTradingValueSol: typeof input.context.trader.lpTradingValueSol === 'number' ? input.context.trader.lpTradingValueSol : undefined,
    lpEntryTradingSol: typeof input.context.trader.lpEntryTradingSol === 'number' ? input.context.trader.lpEntryTradingSol : undefined,
    valuationCompleteness: firstValuationCompleteness(
      input.context.trader.valuationCompleteness,
      input.context.trader.lpValuationCompleteness
    ),
    valuationTrust: firstValuationTrust(input.context.trader.valuationTrust, input.context.trader.lpValuationTrust),
    settlementEvidence: input.settlementEvidence
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
  settlementEvidence?: LiveCycleOutcomeRecord['exitMetrics']['settlementEvidence'];
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
      quote: input.quote,
      settlementEvidence: input.settlementEvidence
    });
    const entrySol = resolveOutcomeEntrySol({
      snapshot: input.snapshot,
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
      captureMode: input.logContext.captureMode,
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
  snapshot?: Record<string, unknown>;
  positionState?: PositionStateSnapshot;
  confirmedFill?: LiveCycleConfirmedFill;
}) {
  if (typeof input.snapshot?.entrySol === 'number' && input.snapshot.entrySol > 0) {
    return input.snapshot.entrySol;
  }

  if (
    isTrustedEntrySolSource(input.positionState?.entrySolSource)
    && typeof input.positionState?.entrySol === 'number'
    && input.positionState.entrySol > 0
  ) {
    return input.positionState.entrySol;
  }

  if (
    (input.confirmedFill?.side === 'add-lp' || input.confirmedFill?.side === 'deploy')
    && input.confirmedFill.fillAmountSource === 'wallet-delta'
    && input.confirmedFill.filledSol > 0
  ) {
    return input.confirmedFill.filledSol;
  }

  return undefined;
}

function resolveActiveLpExitPositionSol(input: {
  action: LiveAction;
  activeLpExitEntrySol?: number;
  positionState?: PositionStateSnapshot;
  allowPositionStateFallback?: boolean;
}) {
  if (
    input.action === 'withdraw-lp'
    && typeof input.activeLpExitEntrySol === 'number'
    && input.activeLpExitEntrySol > 0
  ) {
    return input.activeLpExitEntrySol;
  }

  if (
    input.action === 'withdraw-lp'
    && input.allowPositionStateFallback !== false
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

function isPositionAlreadyClosedReason(reason?: string) {
  return typeof reason === 'string' && /position not found for pool/i.test(reason);
}

function isExitPositionAlreadyClosedFailure(input: {
  action: LiveAction;
  reason?: string;
}) {
  return input.action === 'withdraw-lp'
    && isPositionAlreadyClosedReason(input.reason);
}

function normalizeNotSubmittedBroadcastReason(input: {
  action: LiveAction;
  reason?: string;
}) {
  if (isExitPositionAlreadyClosedFailure(input)) {
    return `position-already-closed:${input.reason}`;
  }

  return input.reason;
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
  const lpTotalValueSol = typeof input.context.trader.lpTotalValueSol === 'number'
    ? input.context.trader.lpTotalValueSol
    : undefined;
  const liquidityValueSol = typeof input.context.trader.lpLiquidityValueSol === 'number'
    ? input.context.trader.lpLiquidityValueSol
    : undefined;
  const unclaimedFeeValueSol = typeof input.context.trader.lpUnclaimedFeeValueSol === 'number'
    ? input.context.trader.lpUnclaimedFeeValueSol
    : undefined;
  const claimedFeeValueSol = typeof input.context.trader.lpClaimedFeeValueSol === 'number'
    ? input.context.trader.lpClaimedFeeValueSol
    : undefined;
  const recoverableRentSol = typeof input.context.trader.lpRecoverableRentSol === 'number'
    ? input.context.trader.lpRecoverableRentSol
    : undefined;
  const valuationStatus = firstString(input.context.trader.valuationStatus, input.context.trader.lpValuationStatus);
  const valuationSource = firstString(input.context.trader.valuationSource, input.context.trader.lpValuationSource);
  const valuationCompleteness = firstString(input.context.trader.valuationCompleteness, input.context.trader.lpValuationCompleteness);
  const valuationTrust = firstString(input.context.trader.valuationTrust, input.context.trader.lpValuationTrust);

  return hasTrustedLpExitValue({
    currentValueSol,
    lpTotalValueSol,
    exitQuoteValueSol: input.context.trader.exitQuoteValueSol,
    liquidityValueSol,
    unclaimedFeeValueSol,
    claimedFeeValueSol,
    recoverableRentSol,
    valuationStatus,
    valuationSource,
    valuationCompleteness,
    valuationTrust,
    tokenQuoteRequirement: 'unknown'
  });
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
      token.mint === input.tokenMint && hasActionableTokenAmount(token)
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
    token.mint === input.tokenMint && hasActionableTokenAmount(token)
  );
}

async function resolveActualFillAmount(input: {
  action: LiveAction;
  tokenMint: string;
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
    const observesTokenDelta = input.action === 'deploy' || input.action === 'dca-out';
    const beforeTokenAmountRaw = observesTokenDelta
      ? sumWalletTokenAmountRaw(input.beforeAccountState, input.tokenMint)
      : undefined;
    const afterTokenAmountRaw = observesTokenDelta
      ? sumWalletTokenAmountRaw(afterAccountState, input.tokenMint)
      : undefined;
    const acquiredTokenAmountRaw = beforeTokenAmountRaw !== undefined
      && afterTokenAmountRaw !== undefined
      && /^\d+$/.test(beforeTokenAmountRaw)
      && /^\d+$/.test(afterTokenAmountRaw)
      && BigInt(afterTokenAmountRaw) > BigInt(beforeTokenAmountRaw)
        ? (BigInt(afterTokenAmountRaw) - BigInt(beforeTokenAmountRaw)).toString()
        : undefined;
    const disposedTokenAmountRaw = beforeTokenAmountRaw !== undefined
      && afterTokenAmountRaw !== undefined
      && /^\d+$/.test(beforeTokenAmountRaw)
      && /^\d+$/.test(afterTokenAmountRaw)
      && BigInt(beforeTokenAmountRaw) > BigInt(afterTokenAmountRaw)
        ? (BigInt(beforeTokenAmountRaw) - BigInt(afterTokenAmountRaw)).toString()
        : undefined;

    if (
      typeof actualFilledSol !== 'number'
      || actualFilledSol <= 0
      || (input.action === 'deploy' && !acquiredTokenAmountRaw)
    ) {
      return {
        ...fallback,
        actualWalletDeltaSol,
        acquiredTokenAmountRaw,
        disposedTokenAmountRaw,
        postAccountState: afterAccountState,
        preWalletSol: roundSolLamports(input.beforeAccountState.walletSol),
        postWalletSol: roundSolLamports(afterAccountState.walletSol)
      };
    }

    return {
      filledSol: roundSolLamports(actualFilledSol),
      actualFilledSol: roundSolLamports(actualFilledSol),
      actualWalletDeltaSol,
      acquiredTokenAmountRaw,
      disposedTokenAmountRaw,
      postAccountState: afterAccountState,
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
    (
      actualExitReason.includes('sol-depletion')
      || actualExitReason.includes('sol-depleted')
      || actualExitReason.includes('sol-nearly-depleted')
    ) &&
    typeof exitMetrics.lpSolDepletedBins === 'number'
  ) {
    return exitMetrics.lpSolDepletedBins;
  }

  if (
    (actualExitReason.includes('stop-loss') || action === 'withdraw-lp')
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
  previousRiskSentinel?: LpRiskSentinelSnapshot;
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
  const lpRiskSentinel = evaluateLpRiskSentinel({
    observedAt,
    activeBinId: input.position.activeBinId,
    lowerBinId: input.position.lowerBinId,
    upperBinId: input.position.upperBinId,
    solDepletedBins: lpSolDepletedBins,
    binCount: input.position.binCount,
    solDepletionExitBins: input.solDepletionExitBins,
    currentValueSol: input.position.currentValueSol,
    liquidityValueSol: input.position.liquidityValueSol,
    currentPrice: input.position.currentPrice,
    previous: input.previousRiskSentinel
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
    lpLiquidityValueSol: input.position.liquidityValueSol,
    lpTotalValueSol: input.position.lpTotalValueSol,
    exitQuoteValueSol: input.position.exitQuoteValueSol,
    marketValueSol: input.position.marketValueSol,
    displayValueSol: input.position.displayValueSol,
    lpUnclaimedFeeSol: input.position.unclaimedFeeSol,
    lpUnclaimedFeeValueSol: input.position.unclaimedFeeValueSol,
    lpClaimedFeeValueSol: input.position.claimedFeeValueSol,
    lpRecoverableRentSol: input.position.recoverableRentSol,
    lpSolDepletedBins,
    lpSolExposureStatus,
    lpRiskSentinel,
    lpRiskIntent: lpRiskSentinel.riskIntent,
    lpRiskReason: lpRiskSentinel.riskReason,
    lpActiveBinId: lpRiskSentinel.activeBinId,
    lpLowerBinId: lpRiskSentinel.lowerBinId,
    lpUpperBinId: lpRiskSentinel.upperBinId,
    lpActiveBinDistanceToLower: lpRiskSentinel.activeBinDistanceToLower,
    lpActiveBinDistanceToUpper: lpRiskSentinel.activeBinDistanceToUpper,
    lpOutOfRangeSide: lpRiskSentinel.outOfRangeSide,
    lpOutOfRangeBins: lpRiskSentinel.outOfRangeBins,
    lpActiveBinStatus: typeof input.position.activeBinId === 'number'
      && typeof input.position.lowerBinId === 'number'
      && typeof input.position.upperBinId === 'number'
      ? (input.position.activeBinId >= input.position.lowerBinId && input.position.activeBinId <= input.position.upperBinId ? 'in-range' : 'out-of-range')
      : undefined,
    valuationStatus: valuation.valuationStatus,
    valuationReason: valuation.valuationReason,
    valuationSource: input.position.valuationSource,
    valuationCompleteness: input.position.valuationCompleteness,
    valuationTrust: input.position.valuationTrust,
    holdTimeMs: input.holdTimeMs,
    pendingConfirmationStatus: 'confirmed' as const,
    lifecycleState: 'open'
  };
}

function resolveLifecycleOpenFill(input: {
  fills: LiveFillEntry[];
  position: NonNullable<LiveAccountState['walletLpPositions']>[number];
  positionState?: PositionStateSnapshot;
  ledgerRecord?: PositionLedgerRecord;
}) {
  const entryFills = input.fills
    .filter((fill) => (fill.side === 'add-lp' || fill.side === 'buy') && fill.amount > 0);

  const byLedgerOpenIntent = input.ledgerRecord?.openIntentId
    ? entryFills
      .filter((fill) =>
        isTrustedLpOpenFill(fill)
        && fill.openIntentId === input.ledgerRecord?.openIntentId
        && fill.mint === input.position.mint
      )
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0]
    : undefined;

  if (byLedgerOpenIntent) {
    return byLedgerOpenIntent;
  }

  const byLedgerSubmission = input.ledgerRecord?.entryFillSubmissionId
    ? entryFills
      .filter((fill) =>
        isTrustedLpOpenFill(fill)
        && fill.submissionId === input.ledgerRecord?.entryFillSubmissionId
        && fill.mint === input.position.mint
      )[0]
    : undefined;

  if (byLedgerSubmission) {
    return byLedgerSubmission;
  }

  const chainPositionAddress = input.position.chainPositionAddress || input.position.positionAddress;
  const byChainAddress = entryFills
    .filter((fill) =>
      isTrustedLpOpenFill(fill)
      && Boolean(chainPositionAddress)
      && (
        fill.chainPositionAddress === chainPositionAddress
        || fill.positionId === chainPositionAddress
      )
    )
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))[0];

  if (byChainAddress) {
    return byChainAddress;
  }

  if (!input.positionState) {
    return undefined;
  }

  const boundByPositionState = positionStateOwnsLpPosition(input.position, input.positionState)
    ? entryFills
      .filter((fill) => classifyLpEntryFillBinding({
        fill,
        positionState: input.positionState!
      }) !== 'none')
      .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt))
    : [];

  if (boundByPositionState[0]) {
    return boundByPositionState[0];
  }
  return undefined;
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

function trustedFillSolAmount(fill: LiveFillEntry) {
  if (fill.hasFillEvidence !== true || !isTrustedFillAmountSource(fill.fillAmountSource)) {
    return undefined;
  }

  const amount = typeof fill.actualFilledSol === 'number' && Number.isFinite(fill.actualFilledSol)
    ? fill.actualFilledSol
    : fill.amount;
  return amount > 0 ? amount : undefined;
}

function fillRecordedAtMs(fill: LiveFillEntry) {
  const recordedAtMs = Date.parse(fill.recordedAt);
  return Number.isFinite(recordedAtMs) ? recordedAtMs : undefined;
}

function claimFeeFillStronglyMatchesPosition(input: {
  fill: LiveFillEntry;
  position?: NonNullable<LiveAccountState['walletLpPositions']>[number];
  positionState?: PositionStateSnapshot;
}) {
  const { fill, position, positionState } = input;
  if (fill.side !== 'claim-fee') {
    return false;
  }

  const chainPositionAddress = positionState?.chainPositionAddress ?? position?.chainPositionAddress ?? position?.positionAddress;
  if (chainPositionAddress && fill.chainPositionAddress === chainPositionAddress) {
    return true;
  }

  const positionId = positionState?.positionId ?? position?.positionId;
  if (positionId && fill.positionId === positionId) {
    return true;
  }

  if (positionState?.openIntentId && fill.openIntentId === positionState.openIntentId) {
    return true;
  }

  const poolAddress = positionState?.activePoolAddress ?? position?.poolAddress;
  const mint = positionState?.activeMint ?? position?.mint;
  if (poolAddress && mint && fill.positionId === `${poolAddress}:${mint}`) {
    return true;
  }

  return false;
}

function claimFeeFillCouldBelongToPosition(input: {
  fill: LiveFillEntry;
  position?: NonNullable<LiveAccountState['walletLpPositions']>[number];
  positionState?: PositionStateSnapshot;
  openedAt?: string;
}) {
  const { fill, position, positionState } = input;
  if (fill.side !== 'claim-fee') {
    return false;
  }

  const mint = positionState?.activeMint ?? position?.mint;
  if (mint && fill.mint !== mint) {
    return false;
  }

  const openedAtMs = input.openedAt ? Date.parse(input.openedAt) : undefined;
  const fillAtMs = fillRecordedAtMs(fill);
  if (
    typeof openedAtMs === 'number'
    && Number.isFinite(openedAtMs)
    && typeof fillAtMs === 'number'
    && fillAtMs < openedAtMs - 60_000
  ) {
    return false;
  }

  return true;
}

function resolveClaimedFeeValueSol(input: {
  fills: LiveFillEntry[];
  position?: NonNullable<LiveAccountState['walletLpPositions']>[number];
  positionState?: PositionStateSnapshot;
  openedAt?: string;
}): { status: 'resolved'; valueSol: number } | { status: 'ambiguous'; reason: string } {
  const trustedClaimFills = input.fills.filter((fill) =>
    fill.side === 'claim-fee'
    && typeof trustedFillSolAmount(fill) === 'number'
    && claimFeeFillCouldBelongToPosition({
      fill,
      position: input.position,
      positionState: input.positionState,
      openedAt: input.openedAt
    })
  );

  const matched = trustedClaimFills.filter((fill) =>
    claimFeeFillStronglyMatchesPosition({
      fill,
      position: input.position,
      positionState: input.positionState
    })
  );
  const ambiguous = trustedClaimFills.filter((fill) => !matched.includes(fill));

  if (ambiguous.length > 0) {
    return { status: 'ambiguous', reason: 'claim-fee-attribution-ambiguous' };
  }

  return {
    status: 'resolved',
    valueSol: matched.reduce((sum, fill) => sum + (trustedFillSolAmount(fill) ?? 0), 0)
  };
}

function applyClaimedFeeValueToPosition(input: {
  position: NonNullable<LiveAccountState['walletLpPositions']>[number];
  claimedFeeValueSol: number;
}) {
  const previousClaimedFeeValueSol = finiteNonnegative(input.position.claimedFeeValueSol) ?? 0;
  const previousTotalValueSol = finiteNonnegative(input.position.lpTotalValueSol);
  const liquidityValueSol = finiteNonnegative(input.position.liquidityValueSol);
  const unclaimedFeeValueSol = finiteNonnegative(input.position.unclaimedFeeValueSol);
  const recoverableRentSol = finiteNonnegative(input.position.recoverableRentSol) ?? 0;
  const lpTotalValueSol = typeof previousTotalValueSol === 'number'
    ? Math.max(0, previousTotalValueSol - previousClaimedFeeValueSol + input.claimedFeeValueSol)
    : typeof liquidityValueSol === 'number' && typeof unclaimedFeeValueSol === 'number'
      ? liquidityValueSol + unclaimedFeeValueSol + input.claimedFeeValueSol + recoverableRentSol
      : undefined;

  return {
    ...input.position,
    claimedFeeValueSol: input.claimedFeeValueSol,
    lpTotalValueSol,
    currentValueSol: lpTotalValueSol ?? input.position.currentValueSol
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
    if (
      reason?.startsWith('lp-range-exit') ||
      reason?.startsWith('lp-liquidity-exit') ||
      reason?.startsWith('lp-volatility-exit')
    ) {
      return 700;
    }

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

function finiteNonnegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function rawLamportsAmountIsPositive(value: unknown) {
  if (typeof value === 'string') {
    return /^\d+$/.test(value) && BigInt(value) > 0n;
  }

  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function lpPositionRequiresTokenQuote(position: NonNullable<LiveAccountState['walletLpPositions']>[number]) {
  return rawLamportsAmountIsPositive(position.withdrawTokenAmountRaw)
    || rawLamportsAmountIsPositive(position.withdrawTokenAmountLamports)
    || rawLamportsAmountIsPositive(position.unclaimedFeeTokenAmountRaw)
    || rawLamportsAmountIsPositive(position.unclaimedFeeTokenAmountLamports);
}

function hasRequiredLpTokenQuotes(position: NonNullable<LiveAccountState['walletLpPositions']>[number]) {
  const valuationSource = typeof position.valuationSource === 'string' ? position.valuationSource : '';
  const needsWithdrawTokenQuote = rawLamportsAmountIsPositive(position.withdrawTokenAmountRaw)
    || rawLamportsAmountIsPositive(position.withdrawTokenAmountLamports);
  const needsFeeTokenQuote = rawLamportsAmountIsPositive(position.unclaimedFeeTokenAmountRaw)
    || rawLamportsAmountIsPositive(position.unclaimedFeeTokenAmountLamports);

  if (
    needsWithdrawTokenQuote
    && (
      !valuationSource.includes('swap-provider-sell-quote')
      || typeof finiteNonnegative(position.withdrawTokenValueSol) !== 'number'
    )
  ) {
    return false;
  }

  if (
    needsFeeTokenQuote
    && (
      !valuationSource.includes('fee-swap-provider-sell-quote')
      || typeof finiteNonnegative(position.unclaimedFeeTokenValueSol) !== 'number'
    )
  ) {
    return false;
  }

  return true;
}

function resolveLpTotalValueSol(input: {
  currentValueSol?: unknown;
  lpTotalValueSol?: unknown;
  liquidityValueSol?: unknown;
  unclaimedFeeValueSol?: unknown;
  claimedFeeValueSol?: unknown;
  recoverableRentSol?: unknown;
}) {
  const explicitTotal = finiteNonnegative(input.lpTotalValueSol);
  if (typeof explicitTotal === 'number') {
    return explicitTotal;
  }

  const liquidityValueSol = finiteNonnegative(input.liquidityValueSol);
  const unclaimedFeeValueSol = finiteNonnegative(input.unclaimedFeeValueSol);
  const claimedFeeValueSol = finiteNonnegative(input.claimedFeeValueSol) ?? 0;
  const recoverableRentSol = finiteNonnegative(input.recoverableRentSol) ?? 0;
  if (typeof liquidityValueSol === 'number' && typeof unclaimedFeeValueSol === 'number') {
    return liquidityValueSol + unclaimedFeeValueSol + claimedFeeValueSol + recoverableRentSol;
  }

  return finiteNonnegative(input.currentValueSol);
}

function resolveLpTradingValueSol(input: {
  currentValueSol?: unknown;
  lpTotalValueSol?: unknown;
  exitQuoteValueSol?: unknown;
  liquidityValueSol?: unknown;
  unclaimedFeeValueSol?: unknown;
  claimedFeeValueSol?: unknown;
  recoverableRentSol?: unknown;
}) {
  const exitQuoteValueSol = finiteNonnegative(input.exitQuoteValueSol);
  const recoverableRentSol = finiteNonnegative(input.recoverableRentSol);
  if (typeof exitQuoteValueSol === 'number' && typeof recoverableRentSol === 'number') {
    return Math.max(0, exitQuoteValueSol - recoverableRentSol);
  }

  const liquidityValueSol = finiteNonnegative(input.liquidityValueSol);
  const unclaimedFeeValueSol = finiteNonnegative(input.unclaimedFeeValueSol);
  const claimedFeeValueSol = finiteNonnegative(input.claimedFeeValueSol) ?? 0;
  if (typeof liquidityValueSol === 'number' && typeof unclaimedFeeValueSol === 'number') {
    return liquidityValueSol + unclaimedFeeValueSol + claimedFeeValueSol;
  }

  const lpTotalValueSol = resolveLpTotalValueSol(input);
  if (typeof lpTotalValueSol === 'number' && typeof recoverableRentSol === 'number') {
    return Math.max(0, lpTotalValueSol - recoverableRentSol);
  }

  return undefined;
}

function resolveLpEntryTradingSol(input: {
  entrySol?: unknown;
  recoverableRentSol?: unknown;
}) {
  const entrySol = finiteNonnegative(input.entrySol);
  if (typeof entrySol !== 'number') {
    return undefined;
  }

  const recoverableRentSol = finiteNonnegative(input.recoverableRentSol);
  if (typeof recoverableRentSol === 'number' && recoverableRentSol > 0 && entrySol > recoverableRentSol) {
    return entrySol - recoverableRentSol;
  }

  return entrySol;
}

type LpTokenQuoteRequirement = 'required' | 'not-required' | 'unknown';

function tokenQuoteRequirementSatisfied(
  valuationSource: string,
  requirement: LpTokenQuoteRequirement | undefined,
  evidenceMarker: string
) {
  if (requirement === 'not-required') {
    return true;
  }

  return valuationSource.includes(evidenceMarker);
}

function hasTrustedLpExitValue(input: {
  currentValueSol?: unknown;
  lpTotalValueSol?: unknown;
  exitQuoteValueSol?: unknown;
  liquidityValueSol?: unknown;
  unclaimedFeeValueSol?: unknown;
  claimedFeeValueSol?: unknown;
  recoverableRentSol?: unknown;
  valuationStatus?: unknown;
  valuationSource?: unknown;
  valuationCompleteness?: unknown;
  valuationTrust?: unknown;
  tokenQuoteRequirement?: LpTokenQuoteRequirement;
  feeTokenQuoteRequirement?: LpTokenQuoteRequirement;
}) {
  const valuationSource = typeof input.valuationSource === 'string' ? input.valuationSource : '';
  const lpTotalValueSol = resolveLpTotalValueSol(input);

  if (input.valuationTrust === 'exit_quote') {
    return input.valuationStatus === 'ready'
      && input.valuationCompleteness === 'complete'
      && typeof lpTotalValueSol === 'number'
      && typeof finiteNonnegative(input.exitQuoteValueSol) === 'number';
  }

  return input.valuationStatus === 'ready'
    && input.valuationCompleteness === 'complete'
    && typeof lpTotalValueSol === 'number'
    && valuationSource.includes('withdraw-simulation')
    && !valuationSource.includes('dlmm-active-bin-price-fallback')
    && tokenQuoteRequirementSatisfied(
      valuationSource,
      input.tokenQuoteRequirement ?? 'unknown',
      'swap-provider-sell-quote'
    )
    && tokenQuoteRequirementSatisfied(
      valuationSource,
      input.feeTokenQuoteRequirement ?? 'not-required',
      'fee-swap-provider-sell-quote'
    );
}

function computeTrustedLpNetPnlPct(input: {
  entrySol?: number;
  currentValueSol?: number;
  lpTotalValueSol?: number;
  exitQuoteValueSol?: number;
  liquidityValueSol?: number;
  unclaimedFeeValueSol?: number;
  claimedFeeValueSol?: number;
  recoverableRentSol?: number;
  config: Awaited<ReturnType<typeof loadStrategyConfig>>;
}) {
  const lpTradingValueSol = resolveLpTradingValueSol({
    currentValueSol: input.currentValueSol,
    lpTotalValueSol: input.lpTotalValueSol,
    exitQuoteValueSol: input.exitQuoteValueSol,
    liquidityValueSol: input.liquidityValueSol,
    unclaimedFeeValueSol: input.unclaimedFeeValueSol,
    claimedFeeValueSol: input.claimedFeeValueSol,
    recoverableRentSol: input.recoverableRentSol
  });
  const entryTradingSol = resolveLpEntryTradingSol({
    entrySol: input.entrySol,
    recoverableRentSol: input.recoverableRentSol
  });

  if (
    typeof entryTradingSol !== 'number'
    || entryTradingSol <= 0
    || typeof lpTradingValueSol !== 'number'
  ) {
    return undefined;
  }

  return evaluateLpPnl(entryTradingSol, lpTradingValueSol, 0, {
    stopLossNetPnlPct: input.config.lpConfig?.stopLossNetPnlPct ?? 20,
    takeProfitNetPnlPct: input.config.lpConfig?.takeProfitNetPnlPct ?? 30
  }).unrealizedPct;
}

export function validateLpWithdrawTriggerEligibility(input: {
  action: LiveAction;
  reason?: string;
  snapshot: Record<string, unknown>;
  config: Awaited<ReturnType<typeof loadStrategyConfig>>;
  allowModeledPnl?: boolean;
}): { allowed: true } | { allowed: false; reason: string } {
  if (input.action !== 'withdraw-lp') {
    return { allowed: true };
  }

  if (input.config.poolClass !== 'new-token' || input.config.lpConfig?.enabled !== true) {
    return { allowed: false, reason: 'lp-exit-trigger-not-eligible:lp-disabled' };
  }

  const expected = buildLpExitPolicyDecision({
    hasLpPosition: input.snapshot.hasLpPosition === true,
    lpRiskIntent: input.snapshot.lpRiskIntent === 'hold'
      || input.snapshot.lpRiskIntent === 'range-warning'
      || input.snapshot.lpRiskIntent === 'range-exit'
      || input.snapshot.lpRiskIntent === 'liquidity-exit'
      || input.snapshot.lpRiskIntent === 'volatility-exit'
      ? input.snapshot.lpRiskIntent
      : undefined,
    lpRiskReason: typeof input.snapshot.lpRiskReason === 'string' ? input.snapshot.lpRiskReason : undefined,
    lpNetPnlPct: typeof input.snapshot.lpNetPnlPct === 'number' ? input.snapshot.lpNetPnlPct : undefined,
    lpModeledNetPnlPct: input.allowModeledPnl === true && typeof input.snapshot.lpModeledNetPnlPct === 'number'
      ? input.snapshot.lpModeledNetPnlPct
      : undefined,
    lpModeledPnlSource: input.allowModeledPnl === true
      && input.snapshot.lpModeledPnlSource === 'paper-shadow-dlmm-active-bin-modeled'
      ? input.snapshot.lpModeledPnlSource
      : undefined,
    lpUnclaimedFeeUsd: typeof input.snapshot.lpUnclaimedFeeUsd === 'number' ? input.snapshot.lpUnclaimedFeeUsd : undefined,
    lpSolDepletedBins: typeof input.snapshot.lpSolDepletedBins === 'number' ? input.snapshot.lpSolDepletedBins : undefined,
    lpSolExposureStatus: input.snapshot.lpSolExposureStatus === 'sol-heavy'
      || input.snapshot.lpSolExposureStatus === 'mixed'
      || input.snapshot.lpSolExposureStatus === 'token-heavy'
      || input.snapshot.lpSolExposureStatus === 'sol-depleted'
      ? input.snapshot.lpSolExposureStatus
      : undefined,
    lpActiveBinStatus: input.snapshot.lpActiveBinStatus === 'in-range'
      || input.snapshot.lpActiveBinStatus === 'out-of-range'
      ? input.snapshot.lpActiveBinStatus
      : undefined,
    lpImpermanentLossPct: typeof input.snapshot.lpImpermanentLossPct === 'number' ? input.snapshot.lpImpermanentLossPct : undefined,
    valuationStatus: input.snapshot.valuationStatus === 'ready'
      || input.snapshot.valuationStatus === 'unavailable'
      || input.snapshot.valuationStatus === 'stale'
      || input.snapshot.valuationStatus === 'invalid'
      ? input.snapshot.valuationStatus
      : undefined,
    holdTimeMs: typeof input.snapshot.holdTimeMs === 'number' ? input.snapshot.holdTimeMs : undefined,
    pendingConfirmationStatus: input.snapshot.pendingConfirmationStatus === 'submitted'
      || input.snapshot.pendingConfirmationStatus === 'confirmed'
      || input.snapshot.pendingConfirmationStatus === 'failed'
      || input.snapshot.pendingConfirmationStatus === 'unknown'
      ? input.snapshot.pendingConfirmationStatus
      : undefined
  }, buildStrategyLpExitPolicyConfig(input.config));

  if (expected.action === 'withdraw-lp' && expected.reason === input.reason) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `lp-exit-trigger-not-eligible:expected=${expected.action}:${expected.reason}:actual=withdraw-lp:${input.reason || 'missing'}`
  };
}

type ActiveLpPosition = NonNullable<LiveAccountState['walletLpPositions']>[number];

type EvaluatedLpPosition = {
  position: ActiveLpPosition;
  decision: ReturnType<typeof runEngineCycle>;
  entrySol?: number;
  ledgerRecord?: PositionLedgerRecord;
  snapshot: Record<string, unknown>;
  holdTimeMs: number;
  priority: number;
  lifecycleBound: boolean;
  ownershipEvidenced: boolean;
};

function findLedgerRecordForPosition(input: {
  ledger?: PositionLedgerSnapshot;
  position: ActiveLpPosition;
}) {
  const chainPositionAddress = firstString(
    input.position.chainPositionAddress,
    input.position.positionAddress
  );
  if (chainPositionAddress) {
    return (input.ledger?.records ?? []).find((record) =>
      record.chainPositionAddress === chainPositionAddress
      || record.positionId === chainPositionAddress
      || record.positionKey === `chain-position:${chainPositionAddress}`
    );
  }

  const concretePositionId = input.position.positionId?.includes(':')
    ? undefined
    : input.position.positionId;
  if (!concretePositionId) {
    return undefined;
  }

  return (input.ledger?.records ?? []).find((record) =>
    record.positionId === concretePositionId
    || record.positionKey === `position:${concretePositionId}`
  );
}

function evaluateActiveLpPositions(input: {
  accountState?: LiveAccountState;
  config: Awaited<ReturnType<typeof loadStrategyConfig>>;
  nowMs: number;
  fills: LiveFillEntry[];
  positionState?: PositionStateSnapshot;
  positionLedger?: PositionLedgerSnapshot;
  captureMode?: 'live' | 'mechanical-soak' | 'economic-shadow';
}): EvaluatedLpPosition[] {
  const evaluated: EvaluatedLpPosition[] = [];
  const activePositions = dedupeActiveLpPositions(input.accountState);

  for (const rawPosition of activePositions) {
    const mint = rawPosition.mint;
    if (!mint) {
      continue;
    }

    const lifecycleBound = positionStateOwnsLpPosition(rawPosition, input.positionState);
    const ledgerRecord = findLedgerRecordForPosition({
      ledger: input.positionLedger,
      position: rawPosition
    });
    const openFill = resolveLifecycleOpenFill({
      fills: input.fills,
      position: rawPosition,
      positionState: input.positionState,
      ledgerRecord
    });
    const ledgerEntry = isTrustedEntrySolSource(ledgerRecord?.entrySolSource)
      && typeof ledgerRecord?.entrySol === 'number'
      && ledgerRecord.entrySol > 0
      ? {
        entrySol: ledgerRecord.entrySol,
        entrySolSource: ledgerRecord.entrySolSource,
        entryFillSubmissionId: ledgerRecord.entryFillSubmissionId,
        openedAt: ledgerRecord.openedAt
      }
      : undefined;
    const trustedEntry = ledgerEntry ?? resolveTrustedLpEntry({
      positionState: input.positionState,
      openFill,
      lifecycleBound
    });
    const ownershipEvidenced = hasLightldLpOwnershipEvidence({
      position: rawPosition,
      ledgerRecord,
      positionState: input.positionState,
      trustedOpenFillBound: Boolean(
        openFill
        && isTrustedLpOpenFill(openFill)
        && openFill.submissionId
      )
    });
    if (!ownershipEvidenced) {
      // Wallet ownership is not strategy ownership. A hand-created or
      // another strategy's LP may be visible to the same signer, but it must
      // never become a withdraw/claim/rebalance target without a Lightld
      // open-intent, idempotency, or trusted entry-fill binding.
      continue;
    }
    const entrySol = trustedEntry?.entrySol;
    const claimedFeeResolution = resolveClaimedFeeValueSol({
      fills: input.fills,
      position: rawPosition,
      positionState: lifecycleBound ? input.positionState : undefined,
      openedAt: trustedEntry?.openedAt
    });
    const position = claimedFeeResolution.status === 'resolved'
      ? applyClaimedFeeValueToPosition({
        position: rawPosition,
        claimedFeeValueSol: claimedFeeResolution.valueSol > 0
          ? claimedFeeResolution.valueSol
          : finiteNonnegative(rawPosition.claimedFeeValueSol) ?? 0
      })
      : {
        ...rawPosition,
        valuationStatus: 'unavailable' as const,
        valuationReason: claimedFeeResolution.reason,
        valuationCompleteness: 'incomplete' as const,
        lpTotalValueSol: undefined,
        currentValueSol: undefined
      };
    const currentValueSol = typeof position.currentValueSol === 'number' ? position.currentValueSol : undefined;
    const lpTotalValueSol = typeof position.lpTotalValueSol === 'number' ? position.lpTotalValueSol : undefined;
    const exitQuoteValueSol = typeof position.exitQuoteValueSol === 'number' ? position.exitQuoteValueSol : undefined;
    const liquidityValueSol = typeof position.liquidityValueSol === 'number' ? position.liquidityValueSol : undefined;
    const unclaimedFeeValueSol = typeof position.unclaimedFeeValueSol === 'number' ? position.unclaimedFeeValueSol : undefined;
    const resolvedClaimedFeeValueSol = typeof position.claimedFeeValueSol === 'number' ? position.claimedFeeValueSol : undefined;
    const recoverableRentSol = typeof position.recoverableRentSol === 'number' ? position.recoverableRentSol : undefined;
    const lpTradingValueSol = resolveLpTradingValueSol({
      currentValueSol,
      lpTotalValueSol,
      exitQuoteValueSol,
      liquidityValueSol,
      unclaimedFeeValueSol,
      claimedFeeValueSol: resolvedClaimedFeeValueSol,
      recoverableRentSol
    });
    const lpEntryTradingSol = resolveLpEntryTradingSol({
      entrySol,
      recoverableRentSol
    });
    const lpNetPnlPct = hasTrustedLpExitValue({
      currentValueSol,
      lpTotalValueSol,
      exitQuoteValueSol,
      liquidityValueSol,
      unclaimedFeeValueSol,
      claimedFeeValueSol: resolvedClaimedFeeValueSol,
      recoverableRentSol,
      valuationStatus: position.valuationStatus,
      valuationSource: position.valuationSource,
      valuationCompleteness: position.valuationCompleteness,
      valuationTrust: position.valuationTrust,
      tokenQuoteRequirement: lpPositionRequiresTokenQuote(position) ? 'required' : 'not-required'
    })
      && (
        position.valuationTrust === 'exit_quote'
        || !lpPositionRequiresTokenQuote(position)
        || hasRequiredLpTokenQuotes(position)
      )
      ? computeTrustedLpNetPnlPct({
        entrySol: trustedEntry?.entrySol,
        currentValueSol,
        lpTotalValueSol,
        exitQuoteValueSol,
        liquidityValueSol,
        unclaimedFeeValueSol,
        claimedFeeValueSol: resolvedClaimedFeeValueSol,
        recoverableRentSol,
        config: input.config
      })
      : undefined;
    const lpModeledNetPnlPct = (
      (input.captureMode === 'mechanical-soak' || input.captureMode === 'economic-shadow')
      && position.valuationStatus === 'ready'
      && position.valuationSource === 'paper-shadow-dlmm-active-bin-modeled'
      && position.valuationTrust === 'fallback_display'
      && position.valuationCompleteness === 'untrusted'
      && typeof position.exitQuoteValueSol !== 'number'
    )
      ? computeTrustedLpNetPnlPct({
        entrySol: trustedEntry?.entrySol,
        currentValueSol,
        // A simulated LP never creates a rent-bearing chain account. Keep the
        // model explicit and use zero rent instead of borrowing live evidence.
        recoverableRentSol: recoverableRentSol ?? 0,
        config: input.config
      })
      : undefined;
    const holdStartedAt = trustedEntry?.openedAt
      ?? (lifecycleBound ? input.positionState?.openedAt : undefined)
      ?? openFill?.recordedAt
      ?? ledgerRecord?.firstSeenOnChainAt;
    const holdStartedAtMs = holdStartedAt ? Date.parse(holdStartedAt) : Number.NaN;
    const holdTimeMs = Number.isFinite(holdStartedAtMs)
      ? Math.max(0, input.nowMs - holdStartedAtMs)
      : 0;
    const snapshot: any = buildLpExitSnapshotFromPosition({
      position,
      holdTimeMs,
      solDepletionExitBins: input.config.lpConfig?.solDepletionExitBins,
      previousRiskSentinel: ledgerRecord?.lastRiskSentinel
    });
    if (typeof entrySol === 'number') {
      snapshot.entrySol = entrySol;
    }
    if (typeof lpTradingValueSol === 'number') {
      snapshot.lpTradingValueSol = lpTradingValueSol;
    }
    if (typeof lpEntryTradingSol === 'number') {
      snapshot.lpEntryTradingSol = lpEntryTradingSol;
    }
    if (typeof lpNetPnlPct === 'number') {
      snapshot.lpNetPnlPct = lpNetPnlPct;
    }
    if (typeof lpModeledNetPnlPct === 'number') {
      snapshot.lpModeledNetPnlPct = lpModeledNetPnlPct;
      snapshot.lpModeledPnlSource = 'paper-shadow-dlmm-active-bin-modeled';
    }

    const decision = runEngineCycle({
      engine: 'new-token',
      snapshot,
      config: {
        ...buildStrategyLpExitPolicyConfig(input.config),
        requireSolRoute: true,
        minLiquidityUsd: 0,
        lpEnabled: input.config.lpConfig?.enabled ?? false,
      }
    });

    evaluated.push({
      position,
      decision,
      entrySol,
      ledgerRecord,
      snapshot,
      holdTimeMs,
      priority: decision.action === 'withdraw-lp' || decision.action === 'claim-fee' || decision.action === 'rebalance-lp'
        ? getLpExitPriority(decision.action, decision.audit.reason)
        : 0,
      lifecycleBound,
      ownershipEvidenced
    });
  }

  return evaluated;
}

function sortTriggeredLpExits(left: EvaluatedLpPosition, right: EvaluatedLpPosition) {
  // Capital risk outranks fairness.  Fair rotation is only used between
  // exits of the same severity so a fresh take-profit can never jump ahead
  // of a stop-loss/range exit that already had one failed attempt.
  if (right.priority !== left.priority) {
    return right.priority - left.priority;
  }

  const leftAttemptedAt = left.ledgerRecord?.lastExitAttemptAt;
  const rightAttemptedAt = right.ledgerRecord?.lastExitAttemptAt;
  if (Boolean(leftAttemptedAt) !== Boolean(rightAttemptedAt)) {
    return leftAttemptedAt ? 1 : -1;
  }

  if (leftAttemptedAt && rightAttemptedAt && leftAttemptedAt !== rightAttemptedAt) {
    return leftAttemptedAt.localeCompare(rightAttemptedAt);
  }

  if (right.holdTimeMs !== left.holdTimeMs) {
    return right.holdTimeMs - left.holdTimeMs;
  }

  const rightBins = typeof right.position.solDepletedBins === 'number' ? right.position.solDepletedBins : -1;
  const leftBins = typeof left.position.solDepletedBins === 'number' ? left.position.solDepletedBins : -1;
  return rightBins - leftBins;
}

function selectTriggeredLpExitFromEvaluations(evaluations: EvaluatedLpPosition[]) {
  const triggered = evaluations.filter((evaluation) =>
    evaluation.decision.action === 'withdraw-lp'
    || evaluation.decision.action === 'claim-fee'
    || evaluation.decision.action === 'rebalance-lp'
  );

  triggered.sort(sortTriggeredLpExits);
  return triggered[0] ?? null;
}

function selectObservedLpPositionFromEvaluations(evaluations: EvaluatedLpPosition[]) {
  const observed = evaluations.slice();
  observed.sort((left, right) => {
    if (left.lifecycleBound !== right.lifecycleBound) {
      return left.lifecycleBound ? -1 : 1;
    }

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

  return observed[0] ?? null;
}

function selectTriggeredLpExit(input: {
  accountState?: LiveAccountState;
  config: Awaited<ReturnType<typeof loadStrategyConfig>>;
  nowMs: number;
  fills: LiveFillEntry[];
  positionState?: PositionStateSnapshot;
  positionLedger?: PositionLedgerSnapshot;
  captureMode?: 'live' | 'mechanical-soak' | 'economic-shadow';
}) {
  return selectTriggeredLpExitFromEvaluations(evaluateActiveLpPositions(input));
}

function applyLpObservationToContext(
  context: ReturnType<typeof buildDecisionContext>,
  observation: EvaluatedLpPosition
) {
  if (!observation.position.mint) {
    return;
  }

  context.token.mint = observation.position.mint;
  context.pool.address = observation.position.poolAddress;
  context.token.symbol = firstString(context.token.symbol, observation.position.mint);
  context.trader.hasLpPosition = true;
  context.trader.hasInventory = true;
  context.trader.lpCurrentValueSol = observation.position.currentValueSol;
  context.trader.lpLiquidityValueSol = observation.position.liquidityValueSol;
  context.trader.lpTotalValueSol = observation.position.lpTotalValueSol;
  context.trader.exitQuoteValueSol = observation.position.exitQuoteValueSol;
  context.trader.marketValueSol = observation.position.marketValueSol;
  context.trader.displayValueSol = observation.position.displayValueSol;
  context.trader.lpUnclaimedFeeSol = observation.position.unclaimedFeeSol;
  context.trader.lpUnclaimedFeeValueSol = observation.position.unclaimedFeeValueSol;
  context.trader.lpClaimedFeeValueSol = observation.position.claimedFeeValueSol;
  context.trader.lpRecoverableRentSol = observation.position.recoverableRentSol;
  (context.trader as any).lpChainPositionAddress = firstString(
    observation.position.chainPositionAddress,
    observation.position.positionAddress,
    observation.position.positionId
  );
  (context.trader as any).lpEntrySol = observation.entrySol;
  context.trader.lpTradingValueSol = observation.snapshot.lpTradingValueSol;
  context.trader.lpEntryTradingSol = observation.snapshot.lpEntryTradingSol;
  context.trader.lpSolDepletedBins = observation.snapshot.lpSolDepletedBins as number | undefined;
  context.trader.lpRiskSentinel = observation.snapshot.lpRiskSentinel;
  context.trader.lpRiskIntent = observation.snapshot.lpRiskIntent;
  context.trader.lpRiskReason = observation.snapshot.lpRiskReason;
  context.trader.lpActiveBinId = observation.snapshot.lpActiveBinId;
  context.trader.lpLowerBinId = observation.snapshot.lpLowerBinId;
  context.trader.lpUpperBinId = observation.snapshot.lpUpperBinId;
  context.trader.lpActiveBinDistanceToLower = observation.snapshot.lpActiveBinDistanceToLower;
  context.trader.lpActiveBinDistanceToUpper = observation.snapshot.lpActiveBinDistanceToUpper;
  context.trader.lpOutOfRangeSide = observation.snapshot.lpOutOfRangeSide;
  context.trader.lpOutOfRangeBins = observation.snapshot.lpOutOfRangeBins;
  context.trader.lpSolExposureStatus = observation.snapshot.lpSolExposureStatus as
    | 'sol-heavy'
    | 'mixed'
    | 'token-heavy'
    | 'sol-depleted'
    | undefined;
  context.trader.valuationStatus = observation.position.valuationStatus;
  context.trader.valuationReason = observation.position.valuationReason;
  context.trader.valuationSource = observation.position.valuationSource;
  context.trader.valuationCompleteness = observation.position.valuationCompleteness;
  context.trader.valuationTrust = observation.position.valuationTrust;
  context.trader.lpValuationStatus = observation.position.valuationStatus;
  context.trader.lpValuationReason = observation.position.valuationReason;
  context.trader.lpValuationSource = observation.position.valuationSource;
  context.trader.lpValuationCompleteness = observation.position.valuationCompleteness;
  context.trader.lpValuationTrust = observation.position.valuationTrust;
  if (typeof observation.snapshot.lpNetPnlPct === 'number') {
    context.trader.lpNetPnlPct = observation.snapshot.lpNetPnlPct;
  } else {
    delete context.trader.lpNetPnlPct;
  }
  if (typeof observation.snapshot.lpModeledNetPnlPct === 'number') {
    context.trader.lpModeledNetPnlPct = observation.snapshot.lpModeledNetPnlPct;
    context.trader.lpModeledPnlSource = observation.snapshot.lpModeledPnlSource;
    // The active-bin model contains no fee accrual evidence. Drop any stale
    // candidate-context fee value so paper cannot fabricate a claim action.
    delete context.trader.lpUnclaimedFeeUsd;
  } else {
    delete context.trader.lpModeledNetPnlPct;
    delete context.trader.lpModeledPnlSource;
  }
  context.trader.lpActiveBinStatus = observation.snapshot.lpActiveBinStatus as
    | 'in-range'
    | 'out-of-range'
    | undefined;
}

function shouldApplyLpObservationToContext(
  context: ReturnType<typeof buildDecisionContext>,
  observation: EvaluatedLpPosition,
  forced: boolean
) {
  if (observation.lifecycleBound) {
    return true;
  }

  if (forced && observation.ownershipEvidenced) {
    return true;
  }

  const contextPoolAddress = firstString(context.pool.address, context.route.poolAddress);
  if (forced && context.trader.hasLpPosition !== true) {
    return true;
  }
  if (contextPoolAddress) {
    return observation.position.poolAddress === contextPoolAddress;
  }

  const contextMint = firstString(context.token.mint);
  return !contextMint || observation.position.mint === contextMint;
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
    poolCreatedAt: firstString(context.pool.poolCreatedAt, context.pool.capturedAt, context.token.capturedAt),
    requestedPositionSol: firstNumber(context.route.expectedOutSol, context.token.expectedOutSol),
    expectedFeeSol: firstOptionalNumber(context.pool.expectedFeeSol, context.token.expectedFeeSol),
    feeTvlRatio24h: firstOptionalNumber(context.pool.feeTvlRatio24h, context.token.feeTvlRatio24h),
    roundTripCostBps: firstOptionalNumber(
      context.route.roundTripCostBps,
      typeof context.route.slippageBps === 'number' ? context.route.slippageBps * 2 : undefined
    ),
    adverseSelectionBps: firstOptionalNumber(context.pool.adverseSelectionBps, context.token.adverseSelectionBps),
    impermanentLossBps: firstOptionalNumber(context.pool.impermanentLossBps, context.token.impermanentLossBps),
    chainCostSol: firstOptionalNumber(context.route.chainCostSol),
    capitalChargeBps: firstOptionalNumber(context.pool.capitalChargeBps),
    safetyMarginBps: firstOptionalNumber(context.pool.safetyMarginBps)
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
      lpLiquidityValueSol: typeof context.trader.lpLiquidityValueSol === 'number' ? context.trader.lpLiquidityValueSol : undefined,
      lpTotalValueSol: typeof context.trader.lpTotalValueSol === 'number' ? context.trader.lpTotalValueSol : undefined,
      exitQuoteValueSol: typeof context.trader.exitQuoteValueSol === 'number' ? context.trader.exitQuoteValueSol : undefined,
      marketValueSol: typeof context.trader.marketValueSol === 'number' ? context.trader.marketValueSol : undefined,
      displayValueSol: typeof context.trader.displayValueSol === 'number' ? context.trader.displayValueSol : undefined,
      lpUnclaimedFeeSol: typeof context.trader.lpUnclaimedFeeSol === 'number' ? context.trader.lpUnclaimedFeeSol : undefined,
      lpUnclaimedFeeValueSol: typeof context.trader.lpUnclaimedFeeValueSol === 'number' ? context.trader.lpUnclaimedFeeValueSol : undefined,
      lpClaimedFeeValueSol: typeof context.trader.lpClaimedFeeValueSol === 'number' ? context.trader.lpClaimedFeeValueSol : undefined,
      lpRecoverableRentSol: typeof context.trader.lpRecoverableRentSol === 'number' ? context.trader.lpRecoverableRentSol : undefined,
      lpTradingValueSol: typeof context.trader.lpTradingValueSol === 'number' ? context.trader.lpTradingValueSol : undefined,
      lpEntryTradingSol: typeof context.trader.lpEntryTradingSol === 'number' ? context.trader.lpEntryTradingSol : undefined,
      entrySol: typeof (context.trader as any).lpEntrySol === 'number' ? (context.trader as any).lpEntrySol : undefined,
      lpSolDepletedBins: typeof context.trader.lpSolDepletedBins === 'number' ? context.trader.lpSolDepletedBins : undefined,
      lpSolExposureStatus: typeof context.trader.lpSolExposureStatus === 'string' ? context.trader.lpSolExposureStatus : undefined,
      lpImpermanentLossPct: typeof context.trader.lpImpermanentLossPct === 'number' ? context.trader.lpImpermanentLossPct : undefined,
      lpUnclaimedFeeUsd: typeof context.trader.lpUnclaimedFeeUsd === 'number' ? context.trader.lpUnclaimedFeeUsd : undefined,
      lpRiskIntent: typeof context.trader.lpRiskIntent === 'string' ? context.trader.lpRiskIntent : undefined,
      lpRiskReason: typeof context.trader.lpRiskReason === 'string' ? context.trader.lpRiskReason : undefined,
      lpActiveBinId: typeof context.trader.lpActiveBinId === 'number' ? context.trader.lpActiveBinId : undefined,
      lpLowerBinId: typeof context.trader.lpLowerBinId === 'number' ? context.trader.lpLowerBinId : undefined,
      lpUpperBinId: typeof context.trader.lpUpperBinId === 'number' ? context.trader.lpUpperBinId : undefined,
      lpActiveBinDistanceToLower: typeof context.trader.lpActiveBinDistanceToLower === 'number' ? context.trader.lpActiveBinDistanceToLower : undefined,
      lpActiveBinDistanceToUpper: typeof context.trader.lpActiveBinDistanceToUpper === 'number' ? context.trader.lpActiveBinDistanceToUpper : undefined,
      lpOutOfRangeSide: typeof context.trader.lpOutOfRangeSide === 'string' ? context.trader.lpOutOfRangeSide : undefined,
      lpOutOfRangeBins: typeof context.trader.lpOutOfRangeBins === 'number' ? context.trader.lpOutOfRangeBins : undefined,
      lpActiveBinStatus: context.trader.lpActiveBinStatus as any,
      valuationStatus: firstString(context.trader.valuationStatus, context.trader.lpValuationStatus) as any,
      valuationReason: firstString(context.trader.valuationReason, context.trader.lpValuationReason),
      valuationSource: firstString(context.trader.valuationSource, context.trader.lpValuationSource),
      valuationCompleteness: firstString(context.trader.valuationCompleteness, context.trader.lpValuationCompleteness),
      lifecycleState: typeof context.trader.lifecycleState === 'string' ? context.trader.lifecycleState : undefined
    };
  }

  return {
    ...shared,
    inSession: firstBoolean(context.token.inSession, context.trader.inSession),
    hasInventory: firstBoolean(context.trader.hasInventory, context.pool.hasInventory),
    unrealizedPct: typeof context.trader.unrealizedPct === 'number' ? context.trader.unrealizedPct : undefined,
    holdTimeMs: typeof context.trader.holdTimeMs === 'number' ? context.trader.holdTimeMs : undefined,
    lifecycleState: typeof context.trader.lifecycleState === 'string' ? context.trader.lifecycleState : undefined
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
  const liquidityValueSol = typeof input.context.trader.lpLiquidityValueSol === 'number'
    ? input.context.trader.lpLiquidityValueSol
    : undefined;
  const unclaimedFeeValueSol = typeof input.context.trader.lpUnclaimedFeeValueSol === 'number'
    ? input.context.trader.lpUnclaimedFeeValueSol
    : undefined;
  const claimedFeeResolution = resolveClaimedFeeValueSol({
    fills: input.fills,
    positionState: input.positionState,
    openedAt: input.positionState?.openedAt
  });
  if (claimedFeeResolution.status === 'ambiguous') {
    delete input.context.trader.lpNetPnlPct;
    input.context.trader.valuationStatus = 'unavailable';
    input.context.trader.lpValuationStatus = 'unavailable';
    input.context.trader.valuationReason = claimedFeeResolution.reason;
    input.context.trader.lpValuationReason = claimedFeeResolution.reason;
    input.context.trader.valuationCompleteness = 'incomplete';
    input.context.trader.lpValuationCompleteness = 'incomplete';
    return;
  }
  const claimedFeeValueSol = claimedFeeResolution.valueSol > 0
    ? claimedFeeResolution.valueSol
    : typeof input.context.trader.lpClaimedFeeValueSol === 'number'
      ? input.context.trader.lpClaimedFeeValueSol
      : 0;
  if (claimedFeeResolution.valueSol > 0) {
    input.context.trader.lpClaimedFeeValueSol = claimedFeeValueSol;
  }
  const recoverableRentSol = typeof input.context.trader.lpRecoverableRentSol === 'number'
    ? input.context.trader.lpRecoverableRentSol
    : 0;
  const lpTotalValueSol = typeof liquidityValueSol === 'number' && typeof unclaimedFeeValueSol === 'number'
    ? liquidityValueSol + unclaimedFeeValueSol + claimedFeeValueSol + recoverableRentSol
    : typeof input.context.trader.lpTotalValueSol === 'number'
      ? input.context.trader.lpTotalValueSol
      : undefined;
  if (typeof lpTotalValueSol === 'number') {
    input.context.trader.lpTotalValueSol = lpTotalValueSol;
    input.context.trader.lpCurrentValueSol = lpTotalValueSol;
  }
  const lpTradingValueSol = resolveLpTradingValueSol({
    currentValueSol: lpTotalValueSol ?? currentValueSol,
    lpTotalValueSol,
    exitQuoteValueSol: input.context.trader.exitQuoteValueSol,
    liquidityValueSol,
    unclaimedFeeValueSol,
    claimedFeeValueSol,
    recoverableRentSol
  });
  if (typeof lpTradingValueSol === 'number') {
    input.context.trader.lpTradingValueSol = lpTradingValueSol;
  } else {
    delete input.context.trader.lpTradingValueSol;
  }
  const valuationStatus = firstString(input.context.trader.valuationStatus, input.context.trader.lpValuationStatus);
  const valuationSource = firstString(input.context.trader.valuationSource, input.context.trader.lpValuationSource);
  const valuationCompleteness = firstString(input.context.trader.valuationCompleteness, input.context.trader.lpValuationCompleteness);
  const valuationTrust = firstString(input.context.trader.valuationTrust, input.context.trader.lpValuationTrust);
  const observedChainPositionAddress = firstString((input.context.trader as any).lpChainPositionAddress);
  const positionStateMatchesObservedLp = !observedChainPositionAddress
    || input.positionState?.chainPositionAddress === observedChainPositionAddress;
  const positionStateForEntry = positionStateMatchesObservedLp ? input.positionState : undefined;

  if (!hasTrustedLpExitValue({
    currentValueSol: lpTotalValueSol ?? currentValueSol,
    lpTotalValueSol,
    exitQuoteValueSol: input.context.trader.exitQuoteValueSol,
    liquidityValueSol,
    unclaimedFeeValueSol,
    claimedFeeValueSol,
    recoverableRentSol,
    valuationStatus,
    valuationSource,
    valuationCompleteness,
    valuationTrust,
    tokenQuoteRequirement: 'unknown'
  })) {
    delete input.context.trader.lpNetPnlPct;
    return;
  }

  const openFill = resolvePositionStateOpenFill({
    fills: input.fills,
    positionState: positionStateForEntry
  });
  const observedEntrySol = finiteNonnegative((input.context.trader as any).lpEntrySol);
  const trustedEntry = resolveTrustedLpEntry({
    positionState: positionStateForEntry,
    openFill,
    lifecycleBound: positionStateForEntry?.lifecycleState === 'open'
  });
  const entrySol = observedEntrySol ?? trustedEntry?.entrySol;
  const lpEntryTradingSol = resolveLpEntryTradingSol({
    entrySol,
    recoverableRentSol
  });
  if (typeof lpEntryTradingSol === 'number') {
    input.context.trader.lpEntryTradingSol = lpEntryTradingSol;
  } else {
    delete input.context.trader.lpEntryTradingSol;
  }
  const lpNetPnlPct = computeTrustedLpNetPnlPct({
    entrySol,
    currentValueSol: lpTotalValueSol ?? currentValueSol,
    lpTotalValueSol,
    exitQuoteValueSol: finiteNonnegative(input.context.trader.exitQuoteValueSol),
    liquidityValueSol,
    unclaimedFeeValueSol,
    claimedFeeValueSol,
    recoverableRentSol,
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
  if (input.action === 'dca-out') {
    if (input.positionState?.ownedTokenAmountRaw) {
      return {
        openIntentId: input.positionState.openIntentId,
        positionId: input.positionState.positionId,
        chainPositionAddress: input.positionState.chainPositionAddress
      };
    }
    return {};
  }

  const positionStateMatchesTarget = Boolean(
    input.positionState
    && (
      (input.chainPositionAddress && input.positionState.chainPositionAddress === input.chainPositionAddress)
      || (
        input.positionState.activePoolAddress === input.poolAddress
        && input.positionState.activeMint === input.tokenMint
      )
    )
  );
  const pendingSubmissionMatchesTarget = Boolean(
    input.pendingSubmission
    && (
      (input.chainPositionAddress && input.pendingSubmission.chainPositionAddress === input.chainPositionAddress)
      || (
        input.pendingSubmission.poolAddress === input.poolAddress
        && input.pendingSubmission.tokenMint === input.tokenMint
      )
    )
  );
  const openingAction = input.action === 'add-lp' || input.action === 'deploy';
  const canReusePositionStateIdentity = openingAction
    ? positionStateMatchesTarget && input.positionState?.lifecycleState !== 'closed'
    : positionStateMatchesTarget;
  const canReusePendingIdentity = openingAction
    ? pendingSubmissionMatchesTarget && input.pendingSubmission?.orderAction === input.action
    : pendingSubmissionMatchesTarget;

  const chainPositionAddress = firstString(
    input.chainPositionAddress,
    canReusePositionStateIdentity ? input.positionState?.chainPositionAddress : undefined,
    canReusePendingIdentity ? input.pendingSubmission?.chainPositionAddress : undefined
  ) || undefined;
  const positionId = firstString(
    canReusePositionStateIdentity ? input.positionState?.positionId : undefined,
    canReusePendingIdentity ? input.pendingSubmission?.positionId : undefined
  ) || undefined;
  const openIntentId = firstString(
    canReusePositionStateIdentity ? input.positionState?.openIntentId : undefined,
    canReusePendingIdentity ? input.pendingSubmission?.openIntentId : undefined
  ) || undefined;

  if (openingAction) {
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
    confirmationSignature: isSolanaTransactionSignature(result.confirmationSignature)
      ? result.confirmationSignature
      : undefined
  }];
}

function solanaSignatureOrUndefined(value: string | undefined): string | undefined {
  return isSolanaTransactionSignature(value) ? value : undefined;
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
      | 'quote'
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
      | 'quote'
      | 'signer'
      | 'broadcast'
      | 'recovery'
      | 'runtime-policy';
    reason: string;
    detail?: string;
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
    detail: entry.detail,
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
      detail: entry.detail,
      runtimeMode: logContext.runtimeMode,
      submissionId: entry.submissionId ?? '',
      tokenMint: logContext.tokenMint,
      tokenSymbol: logContext.tokenSymbol,
      recordedAt
    }));
  });
}

function resolveResidualCleanupStatus(result: LiveBroadcastResult | undefined) {
  if (!result || result.status !== 'submitted') {
    return undefined;
  }

  if (result.residualSweepStatus === 'incomplete') {
    return 'residual_cleanup_pending';
  }

  if (result.residualSweepStatus === 'dust_ignored') {
    return 'residual_dust_ignored';
  }

  if (result.residualSweepStatus === 'complete') {
    return 'residual_cleanup_complete';
  }

  return undefined;
}

function resolveResidualExecutionReason(result: LiveBroadcastResult | undefined) {
  if (!result || result.status !== 'submitted') {
    return undefined;
  }

  if (result.residualSweepStatus === 'incomplete') {
    return result.reason ?? 'residual token sweep incomplete';
  }

  if (result.residualSweepStatus === 'dust_ignored') {
    return result.reason ?? 'residual dust ignored';
  }

  return undefined;
}

function isResidualCleanupIncomplete(result: LiveBroadcastResult | undefined) {
  return result?.status === 'submitted' && result.residualSweepStatus === 'incomplete';
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

  const walletTokenInventory = findWalletTokenInventory({
    accountState,
    activeMint: input.positionState?.activeMint
  });
  const largePoolSpotInventory = resolveOwnedSpotInventory({
    accountState,
    activeMint: input.positionState?.activeMint,
    ownedTokenAmountRaw: input.positionState?.ownedTokenAmountRaw
  });
  const managedLargePoolInventory = config.poolClass === 'large-pool'
    && input.positionState?.lifecycleState === 'open'
      ? largePoolSpotInventory.walletInventory
      : undefined;
  const managedLargePoolOwnedInventory = config.poolClass === 'large-pool'
    && input.positionState?.lifecycleState === 'open'
      ? largePoolSpotInventory.ownedInventory
      : undefined;
  const forcedExitToken = (
    input.positionState?.lifecycleState === 'inventory_exit_ready'
    || input.positionState?.lifecycleState === 'inventory_exit_pending'
  ) ? walletTokenInventory : undefined;
  const residualExitIdentityMint = (
    input.positionState?.lifecycleState === 'inventory_exit_ready'
    || input.positionState?.lifecycleState === 'inventory_exit_pending'
  ) ? input.positionState.activeMint : undefined;
  const managedLargePoolUnrealizedPct = managedLargePoolOwnedInventory
    && typeof managedLargePoolOwnedInventory.currentValueSol === 'number'
    && typeof input.positionState?.entrySol === 'number'
    && input.positionState.entrySol > 0
      ? ((managedLargePoolOwnedInventory.currentValueSol - input.positionState.entrySol) / input.positionState.entrySol) * 100
      : undefined;
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
      : residualExitIdentityMint
        ? {
            ...(input.context ?? {}),
            token: {
              ...((input.context?.token as Record<string, unknown> | undefined) ?? {}),
              mint: residualExitIdentityMint,
              hasInventory: true
            },
            trader: {
              ...((input.context?.trader as Record<string, unknown> | undefined) ?? {}),
              hasInventory: true,
              hasLpPosition: false,
              lifecycleState: 'inventory_exit_ready'
            }
          }
      : managedLargePoolInventory
        ? {
            ...(input.context ?? {}),
            pool: {
              ...((input.context?.pool as Record<string, unknown> | undefined) ?? {}),
              address: input.positionState?.activePoolAddress
                ?? (input.context?.pool as Record<string, unknown> | undefined)?.address
                ?? ''
            },
            token: {
              ...((input.context?.token as Record<string, unknown> | undefined) ?? {}),
              mint: managedLargePoolInventory.mint,
              symbol: managedLargePoolInventory.symbol
                ?? (input.context?.token as Record<string, unknown> | undefined)?.symbol
                ?? '',
              hasInventory: true
            },
            trader: {
              ...((input.context?.trader as Record<string, unknown> | undefined) ?? {}),
              hasInventory: true,
              hasLpPosition: false,
              unrealizedPct: managedLargePoolUnrealizedPct,
              lifecycleState: input.positionState?.lifecycleState
            }
          }
        : accountState
          ? {
              ...(input.context ?? {}),
              trader: {
                ...((input.context?.trader as Record<string, unknown> | undefined) ?? {}),
                hasInventory: hasStrategyOwnedInventory({
                  accountState,
                  activeMint: input.positionState?.activeMint,
                  activePoolAddress: input.positionState?.activePoolAddress
                })
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
  
  const positionHoldTimeMs = getHoldTimeMs({
      fills: historicalFills,
      mint: firstString(context.token.mint),
      nowMs: Date.now(),
      positionState: input.positionState
    });
  (snapshot as any).holdTimeMs = positionHoldTimeMs;
  context.trader.holdTimeMs = positionHoldTimeMs;

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
  const preparedBroadcastStore = new PreparedBroadcastStore(stateRootDir);
  const spendingLimitsStore = input.spendingLimitsConfig
    ? new SpendingLimitsStore(
        stateRootDir,
        input.spendingLimitsConfig.dailySpendResetHour ?? 0
      )
    : undefined;
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
    captureMode: input.captureMode,
    routeExists,
    routeSlippageBps,
    killSwitchEngaged: killSwitchState,
    runtimeMode,
    sessionPhase: input.sessionPhase ?? 'active',
    liveEnabled: config.live.enabled
  };
  let activeMint = firstString(input.positionState?.activeMint, logContext.tokenMint, context.token.mint);

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

    if (result.reason.startsWith('spot-ownership-reconcile-required:')) {
      nextLifecycleState = 'reconcile_required';
    }

    const hasLivePendingSubmission = result.liveOrderSubmitted || pendingSubmission !== null;

    if (activeMint) {
      const unresolved = result.reason.includes('journal-open-unresolved') || result.reason.includes('mint-position-already-active:') || result.reason.includes('pending-open:');
      if (unresolved && hasLivePendingSubmission) {
        nextLifecycleState = 'open';
      } else if (!result.liveOrderSubmitted && !hasLivePendingSubmission && !hasStrategyOwnedInventory({
        accountState,
        activeMint,
        activePoolAddress: input.positionState?.activePoolAddress
      })) {
        nextLifecycleState = 'closed';
      }
    } else if (!result.liveOrderSubmitted && !hasLivePendingSubmission) {
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
  let currentActionIdentity: LiveCycleResult['actionIdentity'];
  const blockCycle = async (entry: {
    stage: 'live-config' | 'reconciliation' | 'guards' | 'quote' | 'signer' | 'broadcast' | 'recovery' | 'runtime-policy';
    action: LiveAction;
    reason: string;
    failureDetail?: string;
    audit: { reason: string };
    requestedPositionSol?: number;
    quote?: SolExitQuote;
    executionPlan?: ExecutionPlan;
    orderIntent?: LiveOrderIntent;
    actionIdentity?: LiveCycleResult['actionIdentity'];
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
        detail: entry.failureDetail,
        severity: entry.severity ?? 'warning',
        requestedPositionSol: entry.requestedPositionSol,
        quote: entry.quote,
        submissionId: getBroadcastSubmissionId(entry.broadcastResult),
        reconciliationDeltaSol: entry.reconciliationDeltaSol
      });
    }

    return finalize({
      ...buildBlockedCycleResult({
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
      failureDetail: entry.failureDetail,
      journalPaths: journals.paths,
      killSwitchState
      }),
      actionIdentity: entry.actionIdentity ?? currentActionIdentity
    });
  };
  const preparedBroadcastRecovery = await recoverPreparedBroadcast({
    preparedBroadcastStore,
    pendingSubmissionStore,
    broadcaster: input.broadcaster,
    spendingLimitsStore
  });
  let pendingSubmission = preparedBroadcastRecovery.pendingSubmission;
  if (preparedBroadcastRecovery.blocked) {
    return blockCycle({
      stage: 'recovery',
      action: 'hold',
      reason: preparedBroadcastRecovery.reason,
      audit: { reason: preparedBroadcastRecovery.reason },
      severity: 'error',
      failureKind: 'unknown',
      failureSource: 'recovery',
      quoteCollected: false
    });
  }
  if (config.poolClass === 'new-token') {
    (snapshot as any).pendingConfirmationStatus = resolvePendingConfirmationStatus({
      pendingSubmission,
      positionState: input.positionState,
      mint: firstString(context.token.mint)
    });
  }

  const lpEvaluations = config.poolClass === 'new-token'
    ? evaluateActiveLpPositions({
      accountState,
      config,
      nowMs: Date.now(),
      fills: historicalFills,
      positionState: input.positionState,
      positionLedger: input.positionLedger,
      captureMode: input.captureMode
    })
    : [];
  const triggeredLpExit = selectTriggeredLpExitFromEvaluations(lpEvaluations);
  const multiLpExit = triggeredLpExit
    && shouldApplyLpObservationToContext(context, triggeredLpExit, true)
    ? triggeredLpExit
    : null;
  const observedLpCandidate = multiLpExit ?? selectObservedLpPositionFromEvaluations(lpEvaluations);
  const observedLpPosition = observedLpCandidate
    && shouldApplyLpObservationToContext(context, observedLpCandidate, Boolean(multiLpExit))
    ? observedLpCandidate
    : null;
  if (observedLpPosition) {
    applyLpObservationToContext(context, observedLpPosition);
  }

  // The selected observation is the one source of truth for an LP
  // maintenance decision.  A compatibility position state can describe a
  // different open LP while the ingest context still carries its old
  // pool/mint.  Never combine that old target with the observed LP's chain
  // address when constructing an exit intent.
  const selectedLpObservation = multiLpExit ?? observedLpPosition;
  if (selectedLpObservation?.position.mint) {
    activeMint = selectedLpObservation.position.mint;
    context.token.mint = selectedLpObservation.position.mint;
    logContext.tokenMint = selectedLpObservation.position.mint;
  } else {
    activeMint = firstString(logContext.tokenMint, context.token.mint);
  }
  if (selectedLpObservation?.position.poolAddress) {
    poolAddress = selectedLpObservation.position.poolAddress;
    context.pool.address = poolAddress;
    context.route.poolAddress = poolAddress;
    tokenSymbol = firstString(context.token.symbol, logContext.tokenSymbol, selectedLpObservation.position.mint);
    logContext.poolAddress = poolAddress;
    logContext.tokenSymbol = tokenSymbol;
  }

  const stateBoundOpenTarget = !selectedLpObservation
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
    fills: journals.fills,
    residualTokenSweepMinValueSol: input.residualTokenSweepMinValueSol
  });

  if (config.poolClass === 'new-token' && preEngineMintAggregate.mustCleanupDust) {
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
    (updatedSnapshot as any).holdTimeMs = typeof selectedLpObservation?.snapshot.holdTimeMs === 'number'
      ? selectedLpObservation.snapshot.holdTimeMs
      : (snapshot as any).holdTimeMs;
    (updatedSnapshot as any).pendingConfirmationStatus = typeof selectedLpObservation?.snapshot.pendingConfirmationStatus === 'string'
      ? selectedLpObservation.snapshot.pendingConfirmationStatus
      : (snapshot as any).pendingConfirmationStatus;
    if (typeof selectedLpObservation?.snapshot.entrySol === 'number' && selectedLpObservation.snapshot.entrySol > 0) {
      (updatedSnapshot as any).entrySol = selectedLpObservation.snapshot.entrySol;
    }
    if (typeof selectedLpObservation?.snapshot.lpModeledNetPnlPct === 'number') {
      (updatedSnapshot as any).lpModeledNetPnlPct = selectedLpObservation.snapshot.lpModeledNetPnlPct;
      (updatedSnapshot as any).lpModeledPnlSource = selectedLpObservation.snapshot.lpModeledPnlSource;
    }
    (updatedSnapshot as any).valuationStatus = liveLpValuation?.valuationStatus;
    (updatedSnapshot as any).valuationReason = liveLpValuation?.valuationReason;
    (updatedSnapshot as any).valuationSource = firstString(context.trader.valuationSource, context.trader.lpValuationSource);
    (updatedSnapshot as any).valuationCompleteness = firstString(
      context.trader.valuationCompleteness,
      context.trader.lpValuationCompleteness
    );
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
  if (typeof input.requestedPositionSol === 'number') {
    (updatedSnapshot as any).requestedPositionSol = input.requestedPositionSol;
  }
  const engineResult = multiLpExit?.decision ?? runEngineCycle({
    engine: config.poolClass,
    snapshot: updatedSnapshot,
    config: {
      ...buildStrategyLpExitPolicyConfig(config),
      requireSolRoute: config.hardGates.requireSolRoute,
      minLiquidityUsd: config.hardGates.minLiquidityUsd,
      minPoolAgeMinutes: config.hardGates.minPoolAgeMinutes,
      maxPoolAgeMinutes: config.hardGates.maxPoolAgeMinutes,
      takeProfitPct: config.riskThresholds.takeProfitPct,
      stopLossPct: config.riskThresholds.stopLossPct,
      lpEnabled: config.lpConfig?.enabled ?? false,
      entryEdgeEnabled: config.entryEdge?.enabled ?? false,
      entryEdgeDefaultAdverseSelectionBps: config.entryEdge?.defaultAdverseSelectionBps,
      entryEdgeDefaultImpermanentLossBps: config.entryEdge?.defaultImpermanentLossBps,
      entryEdgeDefaultChainCostSol: config.entryEdge?.defaultChainCostSol,
      entryEdgeDefaultCapitalChargeBps: config.entryEdge?.defaultCapitalChargeBps,
      entryEdgeDefaultSafetyMarginBps: config.entryEdge?.defaultSafetyMarginBps,
    }
  });
  const lpEnabled = config.lpConfig?.enabled ?? false;
  const lpAuditMetrics = [
    `entrySol=${typeof input.positionState?.entrySol === 'number' ? input.positionState.entrySol.toFixed(9) : 'n/a'}`,
    `lpCurrentValueSol=${typeof context.trader.lpCurrentValueSol === 'number' ? context.trader.lpCurrentValueSol.toFixed(9) : 'n/a'}`,
    `lpTotalValueSol=${typeof context.trader.lpTotalValueSol === 'number' ? context.trader.lpTotalValueSol.toFixed(9) : 'n/a'}`,
    `lpLiquidityValueSol=${typeof context.trader.lpLiquidityValueSol === 'number' ? context.trader.lpLiquidityValueSol.toFixed(9) : 'n/a'}`,
    `lpUnclaimedFeeSol=${typeof context.trader.lpUnclaimedFeeSol === 'number' ? context.trader.lpUnclaimedFeeSol.toFixed(9) : 'n/a'}`,
    `lpUnclaimedFeeValueSol=${typeof context.trader.lpUnclaimedFeeValueSol === 'number' ? context.trader.lpUnclaimedFeeValueSol.toFixed(9) : 'n/a'}`,
    `lpClaimedFeeValueSol=${typeof context.trader.lpClaimedFeeValueSol === 'number' ? context.trader.lpClaimedFeeValueSol.toFixed(9) : 'n/a'}`,
    `lpRecoverableRentSol=${typeof context.trader.lpRecoverableRentSol === 'number' ? context.trader.lpRecoverableRentSol.toFixed(9) : 'n/a'}`,
    `lpTradingValueSol=${typeof context.trader.lpTradingValueSol === 'number' ? context.trader.lpTradingValueSol.toFixed(9) : 'n/a'}`,
    `lpEntryTradingSol=${typeof context.trader.lpEntryTradingSol === 'number' ? context.trader.lpEntryTradingSol.toFixed(9) : 'n/a'}`,
    `lpNetPnlPct=${typeof context.trader.lpNetPnlPct === 'number' ? context.trader.lpNetPnlPct.toFixed(2) : 'n/a'}`,
    `lpModeledNetPnlPct=${typeof context.trader.lpModeledNetPnlPct === 'number' ? context.trader.lpModeledNetPnlPct.toFixed(2) : 'n/a'}`,
    `lpModeledPnlSource=${typeof context.trader.lpModeledPnlSource === 'string' ? context.trader.lpModeledPnlSource : 'n/a'}`,
    `lpRiskIntent=${typeof (updatedSnapshot as any).lpRiskIntent === 'string' ? (updatedSnapshot as any).lpRiskIntent : 'n/a'}`,
    `lpRiskReason=${typeof (updatedSnapshot as any).lpRiskReason === 'string' ? (updatedSnapshot as any).lpRiskReason : 'n/a'}`,
    `lpActiveBinId=${typeof (updatedSnapshot as any).lpActiveBinId === 'number' ? String((updatedSnapshot as any).lpActiveBinId) : 'n/a'}`,
    `lpLowerBinId=${typeof (updatedSnapshot as any).lpLowerBinId === 'number' ? String((updatedSnapshot as any).lpLowerBinId) : 'n/a'}`,
    `lpUpperBinId=${typeof (updatedSnapshot as any).lpUpperBinId === 'number' ? String((updatedSnapshot as any).lpUpperBinId) : 'n/a'}`,
    `lpOutOfRangeSide=${typeof (updatedSnapshot as any).lpOutOfRangeSide === 'string' ? (updatedSnapshot as any).lpOutOfRangeSide : 'n/a'}`,
    `lpOutOfRangeBins=${typeof (updatedSnapshot as any).lpOutOfRangeBins === 'number' ? String((updatedSnapshot as any).lpOutOfRangeBins) : 'n/a'}`,
    `lpSolExposureStatus=${typeof (updatedSnapshot as any).lpSolExposureStatus === 'string' ? (updatedSnapshot as any).lpSolExposureStatus : 'n/a'}`,
    `valuationStatus=${typeof (updatedSnapshot as any).valuationStatus === 'string' ? (updatedSnapshot as any).valuationStatus : 'n/a'}`,
    `valuationReason=${typeof (updatedSnapshot as any).valuationReason === 'string' ? (updatedSnapshot as any).valuationReason : 'n/a'}`,
    `valuationSource=${typeof (updatedSnapshot as any).valuationSource === 'string' ? (updatedSnapshot as any).valuationSource : 'n/a'}`,
    `valuationCompleteness=${typeof (updatedSnapshot as any).valuationCompleteness === 'string' ? (updatedSnapshot as any).valuationCompleteness : 'n/a'}`,
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

  if (
    config.poolClass === 'large-pool'
    && input.positionState?.lifecycleState === 'open'
    && largePoolSpotInventory.reconcileReason
  ) {
    return blockCycle({
      stage: 'runtime-policy',
      action: 'hold',
      reason: largePoolSpotInventory.reconcileReason,
      audit: { reason: largePoolSpotInventory.reconcileReason },
      severity: 'error',
      failureSource: 'runtime-policy',
      quoteCollected: false
    });
  }

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
  const actionTargetLpPosition = (
    actionableAction === 'withdraw-lp'
    || actionableAction === 'claim-fee'
    || actionableAction === 'rebalance-lp'
  )
    ? (multiLpExit?.position ?? observedLpPosition?.position)
    : undefined;
  const actionTargetChainPositionAddress = firstString(
    actionTargetLpPosition?.chainPositionAddress,
    actionTargetLpPosition?.positionAddress,
    actionTargetLpPosition?.positionId
  );
  const actionableTokenMint = activeMint || logContext.tokenMint;
  const actionableChainPositionAddress = firstString(
    actionTargetChainPositionAddress,
    input.positionState?.chainPositionAddress
  );
  const hasActiveLpForActionTarget = Boolean(
    observedLpPosition && matchesLpExitTarget({
      position: observedLpPosition.position,
      tokenMint: actionableTokenMint,
      poolAddress,
      chainPositionAddress: actionableChainPositionAddress
    })
  ) || (input.positionLedger?.records ?? []).some((record) => {
    if (record.lifecycleState !== 'open') {
      return false;
    }

    const recordChainPositionAddress = firstString(record.chainPositionAddress, record.positionId);
    if (actionableChainPositionAddress && recordChainPositionAddress) {
      return recordChainPositionAddress === actionableChainPositionAddress;
    }

    return Boolean(
      actionableTokenMint &&
      poolAddress &&
      record.activeMint === actionableTokenMint &&
      record.activePoolAddress === poolAddress
    );
  });

  if (
    config.poolClass === 'new-token' &&
    actionableAction === 'dca-out' &&
    currentLifecycleState === 'open' &&
    hasActiveLpForActionTarget
  ) {
    return blockCycle({
      stage: 'runtime-policy',
      action: 'hold',
      reason: `residual-dca-out-deferred-to-sweep:${actionableTokenMint || 'unknown'}`,
      audit: { reason: `residual-dca-out-deferred-to-sweep:${actionableTokenMint || 'unknown'}` },
      severity: 'warning',
      failureSource: 'runtime-policy',
      quoteCollected: false
    });
  }

  const lpWithdrawTriggerEligibility = validateLpWithdrawTriggerEligibility({
    action: actionableAction,
    reason: engineResult.audit.reason,
    snapshot: updatedSnapshot,
    config,
    allowModeledPnl: input.captureMode === 'mechanical-soak' || input.captureMode === 'economic-shadow'
  });
  if (!lpWithdrawTriggerEligibility.allowed) {
    return blockCycle({
      stage: 'runtime-policy',
      action: 'hold',
      reason: lpWithdrawTriggerEligibility.reason,
      audit: { reason: lpWithdrawTriggerEligibility.reason },
      severity: 'error',
      failureSource: 'runtime-policy',
      quoteCollected: false
    });
  }

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

  const activeLpExitSnapshotEntrySol = firstNumber(
    typeof multiLpExit?.entrySol === 'number' && multiLpExit.entrySol > 0
      ? multiLpExit.entrySol
      : undefined,
    typeof multiLpExit?.snapshot.entrySol === 'number' && multiLpExit.snapshot.entrySol > 0
      ? multiLpExit.snapshot.entrySol
      : undefined,
    actionableAction === 'withdraw-lp' && config.poolClass === 'new-token' && typeof (updatedSnapshot as any).entrySol === 'number' && (updatedSnapshot as any).entrySol > 0
      ? (updatedSnapshot as any).entrySol
      : undefined
  );
  const activeLpExitPositionSol = resolveActiveLpExitPositionSol({
    action: actionableAction,
    activeLpExitEntrySol: activeLpExitSnapshotEntrySol,
    positionState: input.positionState,
    allowPositionStateFallback: !multiLpExit
      && !firstString(
        observedLpPosition?.position.chainPositionAddress,
        observedLpPosition?.position.positionAddress,
        observedLpPosition?.position.positionId
      )
  });
  const activeLpExitTargetSol = actionableAction === 'withdraw-lp' && config.poolClass === 'new-token'
    ? firstPositiveNumber(
      activeLpExitPositionSol,
      typeof (updatedSnapshot as any).entrySol === 'number' && (updatedSnapshot as any).entrySol > 0
        ? (updatedSnapshot as any).entrySol
        : undefined,
      typeof (updatedSnapshot as any).exitQuoteValueSol === 'number' && (updatedSnapshot as any).exitQuoteValueSol > 0
        ? (updatedSnapshot as any).exitQuoteValueSol
        : undefined,
      typeof (updatedSnapshot as any).lpTotalValueSol === 'number' && (updatedSnapshot as any).lpTotalValueSol > 0
        ? (updatedSnapshot as any).lpTotalValueSol
        : undefined,
      typeof (updatedSnapshot as any).lpCurrentValueSol === 'number' && (updatedSnapshot as any).lpCurrentValueSol > 0
        ? (updatedSnapshot as any).lpCurrentValueSol
        : undefined,
      input.requestedPositionSol
    )
    : activeLpExitPositionSol;
  if (
    actionableAction === 'withdraw-lp'
    && config.poolClass === 'new-token'
    && typeof activeLpExitTargetSol !== 'number'
  ) {
    return blockCycle({
      stage: 'runtime-policy',
      action: 'hold',
      reason: 'lp-exit-target-sol-unavailable',
      audit: { reason: 'lp-exit-target-sol-unavailable' },
      severity: 'warning',
      failureSource: 'runtime-policy',
      quoteCollected: false
    });
  }
  const quotedPositionSol = firstNumber(
    actionableAction === 'dca-out'
      && config.poolClass === 'large-pool'
      && typeof managedLargePoolOwnedInventory?.currentValueSol === 'number'
      && managedLargePoolOwnedInventory.currentValueSol > 0
        ? managedLargePoolOwnedInventory.currentValueSol
        : undefined,
    activeLpExitTargetSol,
    context.route.expectedOutSol,
    context.token.expectedOutSol,
    context.pool.expectedOutSol,
    input.requestedPositionSol
  );
  let quote: SolExitQuote;
  let quoteDegradedReason: string | undefined;
  try {
    quote = await quoteProvider.collect({
      expectedOutSol: quotedPositionSol,
      slippageBps: routeSlippageBps,
      routeExists
    });
  } catch (error) {
    const reason = error instanceof Error && error.message.length > 0
      ? error.message
      : String(error);
    if (!isFullExitAction(actionableAction) && actionableAction !== 'claim-fee') {
      return blockCycle({
        stage: 'quote',
        action: actionableAction,
        reason: `quote-unavailable:${reason}`,
        audit: engineResult.audit,
        severity: 'warning',
        failureKind: 'transient',
        failureSource: 'quote',
        quoteCollected: false
      });
    }

    // The runtime quote is bookkeeping, not the executable swap build. Keep
    // every risk-reducing action available and let the execution service make
    // the exact token-size route attempt (and return a retryable failure when
    // the real route is unavailable).
    quoteDegradedReason = `quote-unavailable-reduce-risk-allowed:${reason}`;
    quote = {
      routeExists: false,
      outputSol: Math.max(0, quotedPositionSol),
      slippageBps: routeSlippageBps,
      quotedAt: new Date().toISOString(),
      stale: true
    };
  }

  const requestedPositionSol = resolveRequestedPositionSol({
    activeLpExitPositionSol,
    requestedPositionSol: actionableAction === 'dca-out' ? undefined : input.requestedPositionSol,
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
  if (quoteDegradedReason) {
    await appendIncident(journals, logContext, mirrorSink, {
      stage: 'quote',
      reason: quoteDegradedReason,
      severity: 'warning',
      requestedPositionSol,
      quote
    });
  }

  const executionPoolAddress = actionableAction === 'dca-out' ? '' : poolAddress;
  const executionPlan = {
    strategyId: input.strategy,
    poolAddress: executionPoolAddress,
    exitMint: 'SOL',
    maxSlippageBps: config.solRouteLimits.maxSlippageBps,
    maxImpactBps: config.solRouteLimits.maxImpactBps,
    solExitQuote: quote
  } satisfies ExecutionPlan;

  // `live.enabled` protects real capital.  A strategy that is intentionally
  // disabled for live deployment must still be exercisable end-to-end in the
  // signed simulate-only paper path.
  if (!config.live.enabled && (input.captureMode ?? 'live') === 'live') {
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
      chainPositionAddress: firstString(
        actionTargetChainPositionAddress,
        input.positionState?.chainPositionAddress
      )
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
        chainPositionAddress: firstString(
          actionTargetChainPositionAddress,
          input.positionState?.chainPositionAddress
        )
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
    availableWalletSol: accountState?.walletSol,
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

  const actionIdentity = resolveActionIdentity({
    action: actionableAction,
    positionState: input.positionState,
    pendingSubmission,
    poolAddress: executionPlan.poolAddress,
    tokenMint: logContext.tokenMint,
    chainPositionAddress: actionTargetChainPositionAddress
  });
  if (actionableAction === 'withdraw-lp' && !actionIdentity.chainPositionAddress) {
    return blockCycle({
      stage: 'guards',
      action: actionableAction,
      reason: 'lp-exit-missing-chain-position-address',
      audit: engineResult.audit,
      requestedPositionSol,
      quote,
      executionPlan,
      severity: 'warning',
      quoteCollected: true
    });
  }
  const ownedResidualAmountRaw = actionableAction === 'dca-out' && config.poolClass === 'new-token'
    ? sumOwnedResidualAmountRaw(input.positionLedger, logContext.tokenMint)
    : undefined;
  const ownedSpotAmountRaw = actionableAction === 'dca-out' && config.poolClass === 'large-pool'
    ? largePoolSpotInventory.ownedInventory?.amountRaw
    : undefined;
  const dcaInputAmountRaw = ownedSpotAmountRaw ?? ownedResidualAmountRaw;
  if (
    actionableAction === 'dca-out'
    && !dcaInputAmountRaw
  ) {
    return blockCycle({
      stage: 'guards',
      action: actionableAction,
      reason: config.poolClass === 'large-pool'
        ? (largePoolSpotInventory.reconcileReason ?? 'spot-ownership-reconcile-required:owned-token-amount-missing')
        : 'residual-ownership-amount-unknown',
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
    executionPolicy: input.captureMode === 'mechanical-soak' || input.captureMode === 'economic-shadow'
      ? 'simulate-only'
      : 'broadcast',
    side: resolveOrderIntentSide(actionableAction),
    tokenMint: logContext.tokenMint,
    fullPositionExit: isFullPositionExitAction(actionableAction),
    liquidateResidualTokenToSol: actionableAction === 'withdraw-lp' || actionableAction === 'claim-fee',
    maxSlippageBps: executionPlan.maxSlippageBps,
    maxImpactBps: executionPlan.maxImpactBps,
    inputAmountRaw: actionableAction === 'dca-out' ? dcaInputAmountRaw : undefined,
    preExitTokenAmountRaw: actionableAction === 'withdraw-lp'
      || actionableAction === 'claim-fee'
      || actionableAction === 'dca-out'
      ? sumWalletTokenAmountRaw(accountState, logContext.tokenMint)
      : undefined,
    preEntryTokenAmountRaw: actionableAction === 'deploy'
      ? sumWalletTokenAmountRaw(accountState, logContext.tokenMint)
      : undefined,
    preEntryWalletSol: (actionableAction === 'deploy' || actionableAction === 'add-lp')
      && typeof accountState?.walletSol === 'number'
      ? accountState.walletSol
      : undefined,
    openIntentId: actionIdentity.openIntentId,
    positionId: actionIdentity.positionId,
    chainPositionAddress: actionIdentity.chainPositionAddress
  });
  currentActionIdentity = actionIdentity;
  const buildCurrentOrderLifecycleKey = () => buildMirrorLifecycleKey({
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
    exitTriggerReason?: string;
    executionFailureReason?: string;
    executionFailureDetail?: string;
    executionFailureKind?: string;
    executionFailureOperation?: string;
    rebuildAttemptCount?: number;
    activeBinIdAtBuild?: number;
    lowerBinIdAtBuild?: number;
    upperBinIdAtBuild?: number;
    binSlippageBps?: number;
    residualCleanupStatus?: string;
    residualCleanupValueSol?: number;
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
      exitTriggerReason: entry.exitTriggerReason,
      executionFailureReason: entry.executionFailureReason,
      executionFailureDetail: entry.executionFailureDetail,
      executionFailureKind: entry.executionFailureKind,
      executionFailureOperation: entry.executionFailureOperation,
      rebuildAttemptCount: entry.rebuildAttemptCount,
      activeBinIdAtBuild: entry.activeBinIdAtBuild,
      lowerBinIdAtBuild: entry.lowerBinIdAtBuild,
      upperBinIdAtBuild: entry.upperBinIdAtBuild,
      binSlippageBps: entry.binSlippageBps,
      residualCleanupStatus: entry.residualCleanupStatus,
      residualCleanupValueSol: entry.residualCleanupValueSol,
      updatedAt: entry.updatedAt
    });
    emitMirrorEvent(mirrorSink, () => {
      mirrorSink!.enqueue(toOrderMirrorEvent(buildOrderMirrorPayload({
        lifecycleKey: buildCurrentOrderLifecycleKey(),
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
        exitTriggerReason: entry.exitTriggerReason,
        executionFailureReason: entry.executionFailureReason,
        executionFailureKind: entry.executionFailureKind,
        executionFailureOperation: entry.executionFailureOperation,
        rebuildAttemptCount: entry.rebuildAttemptCount,
        activeBinIdAtBuild: entry.activeBinIdAtBuild,
        lowerBinIdAtBuild: entry.lowerBinIdAtBuild,
        upperBinIdAtBuild: entry.upperBinIdAtBuild,
        binSlippageBps: entry.binSlippageBps,
        residualCleanupStatus: entry.residualCleanupStatus,
        residualCleanupValueSol: entry.residualCleanupValueSol,
        createdAt: logContext.startedAt,
        updatedAt: entry.updatedAt
      })));
    });
  };

  let signedIntent: SignedLiveOrderIntent;
  try {
    signedIntent = await signer.sign(orderIntent);
    await preparedBroadcastStore.write(buildPreparedBroadcastSnapshot({
      strategyId: input.strategy,
      signedIntent,
      action: actionableAction,
      captureMode: input.captureMode,
      openIntentId: actionIdentity.openIntentId,
      positionId: actionIdentity.positionId,
      chainPositionAddress: actionIdentity.chainPositionAddress,
      poolAddress: executionPlan.poolAddress,
      tokenMint: logContext.tokenMint,
      tokenSymbol,
      requestedPositionSol,
      spendReservationRequired: Boolean(
        spendingLimitsStore && actionableActionClass === 'open_risk'
      ),
      createdAt: logContext.startedAt
    }));
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
      exitTriggerReason: engineResult.audit.reason,
      executionFailureReason: reason,
      executionFailureDetail: error instanceof ExecutionRequestError ? error.detail : undefined,
      updatedAt
    });

    return blockCycle({
      stage: 'signer',
      action: actionableAction,
      reason,
      failureDetail: error instanceof ExecutionRequestError ? error.detail : undefined,
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

  if (spendingLimitsStore && actionableActionClass === 'open_risk') {
    try {
      // The signed request is already durable in the prepared-broadcast WAL.
      // Book its full requested exposure before the first network call. A
      // restart can therefore either observe this reservation or recreate it
      // from the WAL before replaying the same idempotency key.
      await spendingLimitsStore.reserveSpend(
        orderIntent.idempotencyKey,
        requestedPositionSol
      );
    } catch (error) {
      const updatedAt = new Date().toISOString();
      const reason = error instanceof Error && error.message.length > 0
        ? error.message
        : 'spending-reservation-failed';
      // No network call has happened. Persist the terminal disposition before
      // deleting the WAL so a crash can never turn this rejected reservation
      // into a future replay.
      await preparedBroadcastStore.markNotSubmitted(reason);
      await preparedBroadcastStore.clear();
      await appendOrderLifecycleState({
        broadcastStatus: 'not_submitted',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        exitTriggerReason: engineResult.audit.reason,
        executionFailureReason: reason,
        updatedAt
      });

      return blockCycle({
        stage: 'recovery',
        action: actionableAction,
        reason,
        audit: engineResult.audit,
        requestedPositionSol,
        quote,
        executionPlan,
        orderIntent,
        confirmationStatus: 'unknown',
        failureKind: 'hard',
        failureSource: 'recovery',
        severity: 'error',
        quoteCollected: true
      });
    }
  }
  let broadcastResult: LiveBroadcastResult;

  try {
    broadcastResult = await broadcaster.broadcast(signedIntent);
  } catch (error) {
    if (!isDefinitelyNotSubmittedBroadcastError(error)) {
      const updatedAt = new Date().toISOString();
      const unknownReason = error instanceof ExecutionRequestError
        ? error.reason
        : 'broadcast-outcome-unknown';
      pendingSubmission = buildUnknownPendingSubmissionSnapshot({
        strategyId: input.strategy,
        captureMode: input.captureMode,
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
        preEntryTokenAmountRaw: orderIntent.preEntryTokenAmountRaw,
        preEntryWalletSol: orderIntent.preEntryWalletSol,
        preExitTokenAmountRaw: orderIntent.preExitTokenAmountRaw,
        requestedPositionSol,
        inputAmountRaw: orderIntent.inputAmountRaw,
        orderAction: actionableAction,
        reason: unknownReason
      });
      await pendingSubmissionStore.write(pendingSubmission);
      await appendOrderLifecycleState({
        broadcastStatus: 'unknown',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        exitTriggerReason: engineResult.audit.reason,
        executionFailureReason: unknownReason,
        executionFailureDetail: error instanceof ExecutionRequestError ? error.detail : undefined,
        updatedAt
      });

      return blockCycle({
        stage: 'broadcast',
        action: actionableAction,
        reason: unknownReason,
        failureDetail: error instanceof ExecutionRequestError ? error.detail : undefined,
        audit: engineResult.audit,
        requestedPositionSol,
        quote,
        executionPlan,
        orderIntent,
        confirmationStatus: 'unknown',
        failureKind: error instanceof ExecutionRequestError ? error.kind : 'unknown',
        failureSource: 'broadcast',
        severity: 'error',
        quoteCollected: true
      });
    }

    const updatedAt = new Date().toISOString();
    const reason = error.reason;
    await preparedBroadcastStore.markNotSubmitted(reason);
    if (spendingLimitsStore && actionableActionClass === 'open_risk') {
      await spendingLimitsStore.releaseSpend(
        orderIntent.idempotencyKey,
        requestedPositionSol
      );
    }
    await preparedBroadcastStore.clear();
    await appendOrderLifecycleState({
      broadcastStatus: 'not_submitted',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      exitTriggerReason: engineResult.audit.reason,
      executionFailureReason: reason,
      executionFailureDetail: error instanceof ExecutionRequestError ? error.detail : undefined,
      updatedAt
    });

    return blockCycle({
      stage: 'broadcast',
      action: actionableAction,
      reason,
      failureDetail: error instanceof ExecutionRequestError ? error.detail : undefined,
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

  const broadcastResponseIdentityFailure = broadcastResult.idempotencyKey !== orderIntent.idempotencyKey
    ? 'broadcast-response-idempotency-mismatch'
    : broadcastResult.status === 'submitted' && !broadcastResult.submissionId
      ? 'broadcast-response-missing-submission-id'
      : '';
  if (broadcastResponseIdentityFailure) {
    const updatedAt = new Date().toISOString();
    pendingSubmission = buildUnknownPendingSubmissionSnapshot({
      strategyId: input.strategy,
      captureMode: input.captureMode,
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
      preEntryTokenAmountRaw: orderIntent.preEntryTokenAmountRaw,
      preEntryWalletSol: orderIntent.preEntryWalletSol,
      preExitTokenAmountRaw: orderIntent.preExitTokenAmountRaw,
      requestedPositionSol,
      inputAmountRaw: orderIntent.inputAmountRaw,
      orderAction: actionableAction,
      reason: broadcastResponseIdentityFailure
    });
    await pendingSubmissionStore.write(pendingSubmission);
    await appendOrderLifecycleState({
      broadcastStatus: 'unknown',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      exitTriggerReason: engineResult.audit.reason,
      executionFailureReason: broadcastResponseIdentityFailure,
      updatedAt
    });
    return blockCycle({
      stage: 'broadcast',
      action: actionableAction,
      reason: broadcastResponseIdentityFailure,
      audit: engineResult.audit,
      requestedPositionSol,
      quote,
      executionPlan,
      orderIntent,
      broadcastResult,
      confirmationStatus: 'unknown',
      failureKind: 'unknown',
      failureSource: 'broadcast',
      severity: 'error',
      quoteCollected: true
    });
  }

  if (broadcastResult.status !== 'submitted') {
    await preparedBroadcastStore.markNotSubmitted(broadcastResult.reason);
    if (spendingLimitsStore && actionableActionClass === 'open_risk') {
      await spendingLimitsStore.releaseSpend(
        orderIntent.idempotencyKey,
        requestedPositionSol
      );
    }
    await preparedBroadcastStore.clear();
    const normalizedFailureReason = normalizeNotSubmittedBroadcastReason({
      action: actionableAction,
      reason: broadcastResult.reason
    }) ?? 'broadcast-not-submitted';
    const failureSeverity = isExitPositionAlreadyClosedFailure({
      action: actionableAction,
      reason: broadcastResult.reason
    }) ? 'warning' : 'error';
    const confirmation: {
      status: ConfirmationStatus;
      reason?: string;
    } = {
      status: 'unknown',
      reason: normalizedFailureReason
    };
    await appendOrderLifecycleState({
      broadcastStatus: 'not_submitted',
      confirmationStatus: confirmation.status,
      finality: 'unknown',
      exitTriggerReason: engineResult.audit.reason,
      executionFailureReason: normalizedFailureReason,
      executionFailureKind: broadcastResult.executionFailureKind,
      executionFailureOperation: broadcastResult.executionFailureOperation,
      rebuildAttemptCount: broadcastResult.rebuildAttemptCount,
      activeBinIdAtBuild: broadcastResult.activeBinIdAtBuild,
      lowerBinIdAtBuild: broadcastResult.lowerBinIdAtBuild,
      upperBinIdAtBuild: broadcastResult.upperBinIdAtBuild,
      binSlippageBps: broadcastResult.binSlippageBps,
      updatedAt: new Date().toISOString()
    });

    return blockCycle({
      stage: 'broadcast',
      action: actionableAction,
      reason: normalizedFailureReason,
      audit: engineResult.audit,
      requestedPositionSol,
      quote,
      executionPlan,
      orderIntent,
      broadcastResult,
      confirmationStatus: confirmation.status,
      failureKind: 'hard',
      failureSource: 'broadcast',
      severity: failureSeverity,
      quoteCollected: true
    });
  }

  if (broadcastResult.chainPositionAddress && !actionIdentity.chainPositionAddress) {
    actionIdentity.chainPositionAddress = broadcastResult.chainPositionAddress;
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
  const broadcasterConfirmedMainExecution =
    broadcastResult.mainExecutionStatus === 'confirmed'
    && broadcastResult.batchStatus !== 'partial';

  if (
    input.confirmationProvider
    && trackedBroadcastSubmissions.length > 0
    && !broadcasterConfirmedMainExecution
  ) {
    try {
      const polledConfirmations = await Promise.all(
        trackedBroadcastSubmissions.map((trackedSubmission) => input.confirmationProvider!.poll(trackedSubmission))
      );
      const normalizedConfirmations = polledConfirmations.map(toConfirmationResult);
      const aggregateConfirmation = aggregateTrackedConfirmations(normalizedConfirmations);

      confirmation = aggregateConfirmation.confirmation;
      confirmationFinality = aggregateConfirmation.finality;
      confirmationCheckedAt = aggregateConfirmation.checkedAt;
    } catch (error) {
      const errorMessage = error instanceof Error && error.message.length > 0
        ? error.message
        : String(error);
      confirmation = {
        status: 'unknown',
        submissionId:
          trackedBroadcastSubmissions[trackedBroadcastSubmissions.length - 1]?.submissionId
          ?? broadcastResult.submissionId,
        reason: `confirmation-poll-failed: ${errorMessage}`
      };
      confirmationFinality = 'unknown';
      confirmationCheckedAt = new Date().toISOString();
    }
  }
  if (config.poolClass === 'large-pool') {
    (updatedSnapshot as any).holdTimeMs = (snapshot as any).holdTimeMs;
  }

  if (
    broadcasterConfirmedMainExecution
    && confirmation.status !== 'failed'
  ) {
    confirmation = {
      status: 'confirmed',
      submissionId: trackedBroadcastSubmissions[trackedBroadcastSubmissions.length - 1]?.submissionId ?? broadcastResult.submissionId
    };
    confirmationFinality = confirmationFinality === 'finalized' ? 'finalized' : 'confirmed';
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
    captureMode: input.captureMode,
    idempotencyKey: orderIntent.idempotencyKey,
    submissionId: broadcastResult.submissionId,
    openIntentId: actionIdentity.openIntentId,
    positionId: actionIdentity.positionId,
    chainPositionAddress: actionIdentity.chainPositionAddress,
    submissionIds: trackedBroadcastSubmissions.map((trackedSubmission) => trackedSubmission.submissionId),
    confirmationSignature: broadcastResult.confirmationSignature,
    confirmationSignatures: trackedBroadcastSubmissions.map((trackedSubmission) =>
      solanaSignatureOrUndefined(trackedSubmission.confirmationSignature)
    ).filter((sig): sig is string => sig !== undefined),
    confirmationStatus: confirmation.status,
    finality: confirmationFinality,
    createdAt: logContext.startedAt,
    updatedAt: confirmationCheckedAt,
    timeoutAt: buildPendingTimeoutAt(logContext.startedAt),
    poolAddress: executionPlan.poolAddress,
    tokenMint: logContext.tokenMint,
    tokenSymbol,
    preEntryTokenAmountRaw: orderIntent.preEntryTokenAmountRaw,
    preEntryWalletSol: orderIntent.preEntryWalletSol,
    preExitTokenAmountRaw: orderIntent.preExitTokenAmountRaw,
    requestedPositionSol,
    inputAmountRaw: orderIntent.inputAmountRaw,
    orderAction: actionableAction,
    batchStatus: broadcastResult.batchStatus,
    residualSweepStatus: broadcastResult.residualSweepStatus,
    residualUnsoldAmountsRaw: broadcastResult.residualUnsoldAmountsRaw,
    reason: confirmation.reason ?? broadcastResult.reason
  });
  await pendingSubmissionStore.write(pendingSubmission);
  await preparedBroadcastStore.clear();

  let lpExitClosureProven = actionableAction !== 'withdraw-lp';
  let postSubmitClosureAccountState: LiveAccountState | undefined;
  if (
    actionableAction === 'withdraw-lp'
    && isResolvedConfirmation(confirmation.status, confirmationFinality)
    && input.accountProvider
  ) {
    try {
      const postSubmitAccountState = await input.accountProvider.readState();
      postSubmitClosureAccountState = postSubmitAccountState;
      lpExitClosureProven = hasFreshCompleteLpExitAbsenceEvidence(
        pendingSubmission,
        postSubmitAccountState
      );
    } catch {
      lpExitClosureProven = false;
    }
  }

  if (
    actionableAction === 'withdraw-lp'
    && isResolvedConfirmation(confirmation.status, confirmationFinality)
    && !lpExitClosureProven
  ) {
    pendingSubmission = {
      ...pendingSubmission,
      reason: 'pending-withdraw-awaiting-account-closure-proof',
      updatedAt: new Date().toISOString()
    };
    await pendingSubmissionStore.write(pendingSubmission);
  }

  if (
    isResolvedConfirmation(confirmation.status, confirmationFinality)
    && lpExitClosureProven
    && actionableAction !== 'dca-out'
    && input.deferResolvedPendingClear !== true
  ) {
    await pendingSubmissionStore.clear();
    pendingSubmission = null;
  }

  const residualCleanupStatus = resolveResidualCleanupStatus(broadcastResult);
  const residualExecutionReason = resolveResidualExecutionReason(broadcastResult);
  await appendOrderLifecycleState({
    submissionId: broadcastResult.submissionId,
    confirmationSignature: broadcastResult.confirmationSignature,
    broadcastStatus: 'submitted',
    confirmationStatus: confirmation.status,
    finality: confirmationFinality,
    exitTriggerReason: engineResult.audit.reason,
    executionFailureReason: residualExecutionReason,
    residualCleanupStatus,
    residualCleanupValueSol: broadcastResult.residualEstimatedValueSol,
    rebuildAttemptCount: broadcastResult.rebuildAttemptCount,
    activeBinIdAtBuild: broadcastResult.activeBinIdAtBuild,
    lowerBinIdAtBuild: broadcastResult.lowerBinIdAtBuild,
    upperBinIdAtBuild: broadcastResult.upperBinIdAtBuild,
    binSlippageBps: broadcastResult.binSlippageBps,
    updatedAt: confirmationCheckedAt
  });

  if (isResidualCleanupIncomplete(broadcastResult)) {
    await appendIncident(journals, logContext, mirrorSink, {
      stage: 'broadcast',
      reason: `residual_cleanup_pending: ${broadcastResult.reason ?? 'residual token sweep incomplete'}`,
      severity: 'warning',
      requestedPositionSol,
      quote,
      submissionId: broadcastResult.submissionId
    });
  }

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
  let actualFillEvidence: ActualFillAmount | undefined;
  const isConfirmedFill = isConfirmedConfirmation(confirmation.status, confirmationFinality);
  if (isConfirmedFill) {
    const actualFill = await resolveActualFillAmount({
      action: actionableAction,
      tokenMint: logContext.tokenMint,
      beforeAccountState: accountState,
      accountProvider: input.accountProvider,
      fallbackSol: requestedPositionSol
    });
    actualFillEvidence = actualFill;
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
        acquiredTokenAmountRaw: actualFill.acquiredTokenAmountRaw,
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
        acquiredTokenAmountRaw: actualFill.acquiredTokenAmountRaw,
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

  const hasActionablePostExitTargetToken = [
    ...(postSubmitClosureAccountState?.walletTokens ?? []),
    ...(postSubmitClosureAccountState?.journalTokens ?? [])
  ].some((token) => token.mint === logContext.tokenMint && hasActionableTokenAmount(token));
  const residualSweepClosureProven = broadcastResult.residualSweepStatus === 'complete'
    || broadcastResult.residualSweepStatus === 'dust_ignored'
    || (
      broadcastResult.residualSweepStatus === undefined
      && !hasActionablePostExitTargetToken
    );
  const withdrawFullExitClosureProven = actionableAction === 'withdraw-lp'
    && lpExitClosureProven
    && residualSweepClosureProven;
  const expectedOwnedExitAmountRaw = input.positionState?.ownedTokenAmountRaw ?? ownedResidualAmountRaw;
  const spotFullExitClosureProven = actionableAction === 'dca-out'
    && isConfirmedFill
    && confirmedFill?.hasFillEvidence === true
    && Boolean(expectedOwnedExitAmountRaw)
    && (input.positionState?.activeMint === logContext.tokenMint || residualExitIdentityMint === logContext.tokenMint)
    && orderIntent.fullPositionExit === true
    && orderIntent.inputAmountRaw === expectedOwnedExitAmountRaw
    && actualFillEvidence?.disposedTokenAmountRaw === orderIntent.inputAmountRaw
    && hasCompleteFreshAccountSnapshot(
      { createdAt: logContext.startedAt },
      actualFillEvidence?.postAccountState
    );
  const fullExitClosureProven = withdrawFullExitClosureProven || spotFullExitClosureProven;
  const submittedActionClosureProven = actionableAction === 'withdraw-lp'
    ? lpExitClosureProven
    : actionableAction === 'dca-out'
      ? spotFullExitClosureProven
      : undefined;

  if (
    actionableAction === 'dca-out'
    && isResolvedConfirmation(confirmation.status, confirmationFinality)
  ) {
    if (fullExitClosureProven && input.deferResolvedPendingClear !== true) {
      await pendingSubmissionStore.clear();
      pendingSubmission = null;
    } else if (!fullExitClosureProven && pendingSubmission) {
      pendingSubmission = {
        ...pendingSubmission,
        reason: 'pending-dca-out-awaiting-exact-token-delta-proof',
        updatedAt: new Date().toISOString()
      };
      await pendingSubmissionStore.write(pendingSubmission);
    }
  }

  if (!fillEvidenceMissing && fullExitClosureProven) {
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
      quote,
      settlementEvidence: logContext.captureMode === 'mechanical-soak'
        ? actionableAction === 'withdraw-lp'
          ? 'paper-synthetic-lp-lifecycle'
          : actionableAction === 'dca-out'
            && broadcastResult.reason === 'paper-dry-run-quoted-shadow-settlement'
            ? 'paper-executable-spot-quote'
            : undefined
        : confirmedFill?.hasFillEvidence === true
          && confirmedFill.fillAmountSource === 'wallet-delta'
          ? 'on-chain-wallet-delta'
          : undefined
    });
  }

  const exitClosureSynchronouslyResolved = actionableAction === 'withdraw-lp'
    ? lpExitClosureProven
    : actionableAction === 'dca-out'
      ? fullExitClosureProven
      : true;
  const lifecycleSynchronouslyResolved = isConfirmedConfirmation(confirmation.status, confirmationFinality)
    && (pendingSubmission === null || input.deferResolvedPendingClear === true)
    && (!fillEvidenceMissing || isFullExitAction(actionableAction))
    && exitClosureSynchronouslyResolved;

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
    actionIdentity,
    confirmedFill,
    submittedActionClosureProven,
    fullExitClosureProven
  }, lifecycleSynchronouslyResolved);
}
