import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveCycleOutcomeRecord } from '../../../src/evolution';
import { appendJsonLine, readJsonLines } from '../../../src/journals/jsonl-writer';
import type { MirrorEvent } from '../../../src/observability/mirror-events';
import { SpendingLimitsStore } from '../../../src/risk/spending-limits';
import { ExecutionRequestError } from '../../../src/execution/error-classification';
import { TestLiveSigner } from '../../../src/execution/live-signer';
import { KillSwitch } from '../../../src/runtime/kill-switch';
import { liveIncidentDedupeStore } from '../../../src/runtime/incident-dedupe';
import { runLiveCycle, validateLpWithdrawTriggerEligibility } from '../../../src/runtime/live-cycle';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';
import { PreparedBroadcastStore } from '../../../src/runtime/prepared-broadcast-store';

const TEST_JOURNAL_DIR = 'tmp/tests/runtime-live-cycle';
const TEST_STATE_DIR = 'tmp/tests/runtime-live-cycle-state';

const baseNewTokenConfig = {
  poolClass: 'new-token',
  live: {
    enabled: true,
    maxLivePositionSol: 1,
    autoFlattenRequired: false,
    maxHoldHours: 8,
    requireMintAuthorityRevoked: false
  },
  lpConfig: {
    enabled: true,
    singleSideMint: 'SOL',
    strategyType: 'bid-ask',
    stopLossNetPnlPct: 20,
    takeProfitNetPnlPct: 30,
    solDepletionExitBins: 60,
    downsideCoveragePct: 66,
    minBinStep: 80,
    minVolume24hUsd: 1000,
    minFeeTvlRatio24h: 0,
    rebalanceOnOutOfRange: false
  }
} as any;

const activeLpPositionState = (overrides: Record<string, unknown> = {}) => ({
  allowNewOpens: true,
  flattenOnly: false,
  lastAction: 'add-lp',
  activeMint: 'mint-safe',
  activePoolAddress: 'pool-1',
  chainPositionAddress: 'pos-1',
  lifecycleState: 'open',
  entrySol: 0.1,
  entrySolSource: 'actual_fill',
  entryFillSubmissionId: 'sub-open',
  openedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides
}) as any;

const paperModeledLpAccountState = (currentValueSol: number, overrides: Record<string, unknown> = {}) => ({
  observedAt: new Date().toISOString(),
  walletSol: 1,
  journalSol: 1,
  walletTokens: [],
  journalTokens: [],
  walletLpPositions: [{
    poolAddress: 'pool-1',
    positionAddress: 'pos-1',
    chainPositionAddress: 'pos-1',
    mint: 'mint-safe',
    lowerBinId: 100,
    upperBinId: 168,
    activeBinId: 120,
    solSide: 'tokenX' as const,
    solDepletedBins: 5,
    currentValueSol,
    displayValueSol: currentValueSol,
    valuationStatus: 'ready' as const,
    valuationReason: '',
    valuationSource: 'paper-shadow-dlmm-active-bin-modeled',
    valuationTrust: 'fallback_display' as const,
    valuationCompleteness: 'untrusted' as const,
    hasLiquidity: true,
    hasClaimableFees: false,
    ...overrides
  }],
  journalLpPositions: [],
  fills: []
});

describe('runLiveCycle', () => {
  beforeEach(async () => {
    liveIncidentDedupeStore.reset();
    await rm(TEST_JOURNAL_DIR, { recursive: true, force: true });
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
  });

  it('rejects withdraw-lp when the claimed take-profit trigger is not eligible', () => {
    const result = validateLpWithdrawTriggerEligibility({
      action: 'withdraw-lp',
      reason: 'lp-take-profit',
      config: baseNewTokenConfig,
      snapshot: {
        hasLpPosition: true,
        lpNetPnlPct: 12,
        holdTimeMs: 10 * 60 * 1000,
        pendingConfirmationStatus: 'confirmed',
        valuationStatus: 'ready'
      }
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'lp-exit-trigger-not-eligible:expected=hold:lp-position-maintain:actual=withdraw-lp:lp-take-profit'
    });
  });

  it('rejects withdraw-lp when the claimed stop-loss trigger lacks ready valuation', () => {
    const result = validateLpWithdrawTriggerEligibility({
      action: 'withdraw-lp',
      reason: 'lp-stop-loss',
      config: baseNewTokenConfig,
      snapshot: {
        hasLpPosition: true,
        lpNetPnlPct: -25,
        valuationStatus: 'unavailable'
      }
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'lp-exit-trigger-not-eligible:expected=hold:lp-position-maintain:actual=withdraw-lp:lp-stop-loss'
    });
  });

  it('keeps lp-sol-nearly-depleted eligible when SOL exposure is explicitly depleted', () => {
    const result = validateLpWithdrawTriggerEligibility({
      action: 'withdraw-lp',
      reason: 'lp-sol-nearly-depleted',
      config: baseNewTokenConfig,
      snapshot: {
        hasLpPosition: true,
        lpSolExposureStatus: 'sol-depleted'
      }
    });

    expect(result).toEqual({ allowed: true });
  });

  it('submits a live order for actionable new-token input and writes journals', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
    const quoteJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.quoteJournalPath);
    const decisionJournal = await readJsonLines<Record<string, unknown>>(
      result.journalPaths.decisionAuditPath
    );
    const fillJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveFillPath);

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.liveOrderSubmitted).toBe(true);
    expect(result.reason).toBe('live-order-submitted');
    expect(orderJournal[0]).toMatchObject({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      requestedPositionSol: 0.1,
      quotedOutputSol: 0.1,
      fullPositionExit: true
    });
    expect(orderJournal[0].cycleId).toEqual(expect.any(String));
    expect(quoteJournal[0]).toMatchObject({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      tokenSymbol: 'SAFE',
      outputSol: 0.1,
      requestedPositionSol: 0.1
    });
    expect(fillJournal).toEqual([]);
    expect(decisionJournal[0]).toMatchObject({
      strategyId: 'new-token-v1',
      stage: 'broadcast',
      action: 'withdraw-lp',
      reason: 'live-order-submitted',
      poolAddress: 'pool-1',
      tokenSymbol: 'SAFE',
      requestedPositionSol: 0.1,
      confirmationStatus: 'submitted'
    });
    expect(decisionJournal[0].cycleId).toBe(orderJournal[0].cycleId);
  });

  it('uses the same strategy and order path for paper and live, changing only execution policy', async () => {
    const intents: Array<Record<string, unknown>> = [];
    const run = async (captureMode: 'live' | 'mechanical-soak') => runLiveCycle({
      strategy: 'new-token-v1',
      captureMode,
      journalRootDir: join(TEST_JOURNAL_DIR, captureMode),
      stateRootDir: join(TEST_STATE_DIR, captureMode),
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (signedIntent) => {
          intents.push(signedIntent.intent as unknown as Record<string, unknown>);
          return {
            status: 'submitted',
            submissionId: `${captureMode}-submission`,
            idempotencyKey: signedIntent.intent.idempotencyKey
          };
        }
      }
    });

    const live = await run('live');
    const paper = await run('mechanical-soak');

    expect(paper.action).toBe(live.action);
    expect(paper.audit.reason).toBe(live.audit.reason);
    expect(paper.executionPlan).toMatchObject({
      poolAddress: live.executionPlan?.poolAddress,
      exitMint: live.executionPlan?.exitMint,
      maxSlippageBps: live.executionPlan?.maxSlippageBps,
      maxImpactBps: live.executionPlan?.maxImpactBps,
      solExitQuote: {
        outputSol: live.executionPlan?.solExitQuote.outputSol,
        slippageBps: live.executionPlan?.solExitQuote.slippageBps
      }
    });
    expect(intents).toHaveLength(2);
    expect(intents[0]).toMatchObject({
      strategyId: 'new-token-v1',
      side: 'withdraw-lp',
      poolAddress: 'pool-1',
      tokenMint: 'mint-safe',
      outputSol: 0.1,
      fullPositionExit: true,
      executionPolicy: 'broadcast'
    });
    expect(intents[1]).toMatchObject({
      strategyId: 'new-token-v1',
      side: 'withdraw-lp',
      poolAddress: 'pool-1',
      tokenMint: 'mint-safe',
      outputSol: 0.1,
      fullPositionExit: true,
      executionPolicy: 'simulate-only'
    });
  });

  it('keeps paper and live LP opens identical through the signed intent boundary', async () => {
    const intents: Array<Record<string, unknown>> = [];
    const run = async (captureMode: 'live' | 'mechanical-soak') => runLiveCycle({
      strategy: 'new-token-v1',
      captureMode,
      journalRootDir: join(TEST_JOURNAL_DIR, `open-${captureMode}`),
      stateRootDir: join(TEST_STATE_DIR, `open-${captureMode}`),
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-open', liquidityUsd: 50_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-open', inSession: true, hasSolRoute: true, symbol: 'OPEN' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (signedIntent) => {
          intents.push(signedIntent.intent as unknown as Record<string, unknown>);
          return {
            status: 'submitted',
            submissionId: `${captureMode}-open-submission`,
            idempotencyKey: signedIntent.intent.idempotencyKey
          };
        }
      }
    });

    const live = await run('live');
    const paper = await run('mechanical-soak');

    expect(paper.action).toBe('add-lp');
    expect(paper.action).toBe(live.action);
    expect(paper.audit.reason).toBe(live.audit.reason);
    expect(paper.executionPlan).toMatchObject({
      strategyId: live.executionPlan?.strategyId,
      poolAddress: live.executionPlan?.poolAddress,
      exitMint: live.executionPlan?.exitMint,
      maxSlippageBps: live.executionPlan?.maxSlippageBps,
      maxImpactBps: live.executionPlan?.maxImpactBps,
      solExitQuote: {
        routeExists: live.executionPlan?.solExitQuote.routeExists,
        outputSol: live.executionPlan?.solExitQuote.outputSol,
        slippageBps: live.executionPlan?.solExitQuote.slippageBps,
        stale: live.executionPlan?.solExitQuote.stale
      }
    });
    expect(intents).toHaveLength(2);
    for (const intent of intents) {
      expect(intent).toMatchObject({
        strategyId: 'new-token-v1',
        side: 'add-lp',
        poolAddress: 'pool-open',
        tokenMint: 'mint-open',
        outputSol: 0.1,
        fullPositionExit: false,
        liquidateResidualTokenToSol: false,
        maxSlippageBps: 100,
        maxImpactBps: 200
      });
    }
    expect(intents[0].executionPolicy).toBe('broadcast');
    expect(intents[1].executionPolicy).toBe('simulate-only');
  });

  it('keeps paper and live residual exits identical through the signed intent boundary', async () => {
    const intents: Array<Record<string, unknown>> = [];
    const run = async (captureMode: 'live' | 'mechanical-soak') => runLiveCycle({
      strategy: 'new-token-v1',
      captureMode,
      journalRootDir: join(TEST_JOURNAL_DIR, `residual-${captureMode}`),
      stateRootDir: join(TEST_STATE_DIR, `residual-${captureMode}`),
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'withdraw-lp',
        activeMint: 'mint-residual',
        activePoolAddress: 'pool-residual',
        lifecycleState: 'inventory_exit_ready',
        updatedAt: '2026-07-17T00:00:00.000Z'
      },
      positionLedger: {
        version: 1,
        records: [{
          positionKey: 'chain-position:closed-lp',
          chainPositionAddress: 'closed-lp',
          activeMint: 'mint-residual',
          activePoolAddress: 'pool-residual',
          lifecycleState: 'inventory_exit_ready',
          lastAction: 'withdraw-lp',
          residualCleanupStatus: 'residual_cleanup_pending',
          residualCleanupAmountRaw: '5000',
          updatedAt: '2026-07-17T00:00:00.000Z'
        }],
        updatedAt: '2026-07-17T00:00:00.000Z'
      },
      accountState: {
        observedAt: new Date().toISOString(),
        walletSol: 1,
        journalSol: 1,
        walletTokens: [{ mint: 'mint-residual', symbol: 'RES', amount: 9, amountRaw: '9000', currentValueSol: 0.2 }],
        journalTokens: [{ mint: 'mint-residual', symbol: 'RES', amount: 9, amountRaw: '9000', currentValueSol: 0.2 }],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      context: {
        pool: { address: 'pool-residual', liquidityUsd: 50_000 },
        token: { mint: 'mint-residual', inSession: true, hasSolRoute: true, symbol: 'RES' },
        trader: { hasInventory: true, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.2, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (signedIntent) => {
          intents.push(signedIntent.intent as unknown as Record<string, unknown>);
          return {
            status: 'submitted',
            submissionId: `${captureMode}-residual-submission`,
            idempotencyKey: signedIntent.intent.idempotencyKey
          };
        }
      }
    });

    const live = await run('live');
    const paper = await run('mechanical-soak');

    expect(paper.action).toBe('dca-out');
    expect(paper.action).toBe(live.action);
    expect(paper.audit.reason).toBe(live.audit.reason);
    expect(paper.executionPlan).toMatchObject({
      strategyId: live.executionPlan?.strategyId,
      poolAddress: live.executionPlan?.poolAddress,
      exitMint: live.executionPlan?.exitMint,
      maxSlippageBps: live.executionPlan?.maxSlippageBps,
      maxImpactBps: live.executionPlan?.maxImpactBps,
      solExitQuote: {
        routeExists: live.executionPlan?.solExitQuote.routeExists,
        outputSol: live.executionPlan?.solExitQuote.outputSol,
        slippageBps: live.executionPlan?.solExitQuote.slippageBps,
        stale: live.executionPlan?.solExitQuote.stale
      }
    });
    expect(intents).toHaveLength(2);
    for (const intent of intents) {
      expect(intent).toMatchObject({
        strategyId: 'new-token-v1',
        side: 'sell',
        poolAddress: '',
        tokenMint: 'mint-residual',
        outputSol: 0.2,
        inputAmountRaw: '5000',
        preExitTokenAmountRaw: '9000',
        fullPositionExit: true,
        liquidateResidualTokenToSol: false,
        maxSlippageBps: 100,
        maxImpactBps: 200
      });
    }
    expect(intents[0].executionPolicy).toBe('broadcast');
    expect(intents[1].executionPolicy).toBe('simulate-only');
  });

  it('blocks a partial withdraw-lp batch while preserving pending lifecycle', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'submitted',
          submissionId: 'sub-close',
          idempotencyKey: intent.intent.idempotencyKey,
          confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
          submissionIds: ['sub-close'],
          confirmationSignatures: ['4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm'],
          batchStatus: 'partial',
          reason: 'Solana transaction failed pre-confirmation'
        })
      }
    });

    const fillJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveFillPath);
    const decisionJournal = await readJsonLines<Record<string, unknown>>(
      result.journalPaths.decisionAuditPath
    );
    const incidentJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveIncidentPath);
    const pendingSubmission = await new PendingSubmissionStore(TEST_STATE_DIR).read();

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('withdraw-lp');
    expect(result.reason).toContain('pending-submission-partial-failure');
    expect(result.liveOrderSubmitted).toBe(true);
    expect(result.confirmationStatus).toBe('unknown');
    expect(result.failureSource).toBe('broadcast');
    expect(result.nextLifecycleState).toBe('lp_exit_pending');
    expect(fillJournal).toEqual([]);
    expect(decisionJournal[0]).toMatchObject({
      stage: 'broadcast',
      mode: 'BLOCKED',
      action: 'withdraw-lp',
      confirmationStatus: 'unknown',
      liveOrderSubmitted: true
    });
    expect(incidentJournal[0]).toMatchObject({
      stage: 'broadcast',
      severity: 'error',
      reason: expect.stringContaining('pending-submission-partial-failure'),
      submissionId: 'sub-close'
    });
    expect(pendingSubmission).toMatchObject({
      submissionId: 'sub-close',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      orderAction: 'withdraw-lp',
      reason: 'pending-submission-partial-failure'
    });
  });

  it('keeps a confirmed full-exit partial batch blocked until residual repair is explicit', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        walletLpPositions: []
      },
      accountProvider: {
        readState: vi.fn(async () => ({
          observedAt: new Date(Date.now() + 1_000).toISOString(),
          walletSol: 1.035,
          journalSol: 1.035,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [],
          journalLpPositions: [],
          fills: []
        }))
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'submitted',
          submissionId: 'sub-close',
          idempotencyKey: intent.intent.idempotencyKey,
          confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
          submissionIds: ['sub-close'],
          confirmationSignatures: ['4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm'],
          batchStatus: 'partial',
          mainExecutionStatus: 'confirmed',
          residualSweepStatus: 'incomplete',
          residualUnsoldMints: ['mint-safe'],
          residualFailureReasons: ['no route'],
          residualEstimatedValueSol: 0.012,
          reason: 'residual token sweep incomplete: mint-safe (no route)'
        })
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: '2026-03-22T00:00:02.000Z'
        })
      }
    });

    const pendingSubmission = await new PendingSubmissionStore(TEST_STATE_DIR).read();

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('withdraw-lp');
    expect(result.liveOrderSubmitted).toBe(true);
    expect(result.confirmationStatus).toBe('unknown');
    expect(result.nextLifecycleState).toBe('lp_exit_pending');
    expect(result.reason).toContain('pending-submission-partial-failure');
    expect(pendingSubmission).toMatchObject({
      submissionId: 'sub-close',
      batchStatus: 'partial',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      reason: 'pending-submission-partial-failure'
    });
  });

  it('keeps a confirmed withdraw pending until a fresh complete snapshot proves the exact LP is gone', async () => {
    const observedAt = new Date(Date.now() + 1_000).toISOString();
    const accountProvider = {
      readState: vi.fn(async () => ({
        observedAt,
        walletSol: 1.01,
        journalSol: 1.01,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'pos-1',
          chainPositionAddress: 'pos-1',
          mint: 'mint-safe',
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      }))
    };
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'pos-1',
          chainPositionAddress: 'pos-1',
          mint: 'mint-safe',
          currentValueSol: 0.1,
          solDepletedBins: 61,
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      },
      accountProvider,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'submitted',
          submissionId: 'sub-confirmed-close',
          idempotencyKey: intent.intent.idempotencyKey,
          confirmationSignature: 'confirmed-close-signature',
          mainExecutionStatus: 'confirmed',
          batchStatus: 'complete',
          chainPositionAddress: 'pos-1'
        })
      }
    });

    const pending = await new PendingSubmissionStore(TEST_STATE_DIR).read();
    expect(result).toMatchObject({
      action: 'withdraw-lp',
      confirmationStatus: 'confirmed',
      nextLifecycleState: 'lp_exit_pending'
    });
    expect(pending).toMatchObject({
      chainPositionAddress: 'pos-1',
      confirmationStatus: 'confirmed',
      reason: 'pending-withdraw-awaiting-account-closure-proof'
    });
  });

  it('does not let an unavailable bookkeeping quote block an LP withdraw', async () => {
    const broadcaster = {
      broadcast: vi.fn(async (intent: any) => ({
        status: 'submitted' as const,
        submissionId: 'sub-quote-degraded-exit',
        idempotencyKey: intent.intent.idempotencyKey
      }))
    };
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      quoteProvider: {
        collect: async () => { throw new Error('quote service offline'); }
      },
      broadcaster,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.liveOrderSubmitted).toBe(true);
    expect(result.quote).toMatchObject({ stale: true, routeExists: false });
    expect(broadcaster.broadcast).toHaveBeenCalledTimes(1);
  });

  it('still attempts a token dca-out when the bookkeeping quote is unavailable', async () => {
    const broadcaster = {
      broadcast: vi.fn(async (intent: any) => ({
        status: 'submitted' as const,
        submissionId: 'sub-quote-degraded-dca-out',
        idempotencyKey: intent.intent.idempotencyKey
      }))
    };
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: false,
        flattenOnly: false,
        lastAction: 'withdraw-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        lifecycleState: 'inventory_exit_ready',
        updatedAt: new Date().toISOString()
      } as any,
      quoteProvider: {
        collect: async () => { throw new Error('quote service offline'); }
      },
      broadcaster: broadcaster as any,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [{ mint: 'mint-safe', amount: 100, amountRaw: '100' }],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      positionLedger: {
        version: 1,
        records: [{
          positionKey: 'residual:mint-safe',
          activeMint: 'mint-safe',
          lifecycleState: 'closed',
          residualCleanupStatus: 'residual_cleanup_pending',
          residualCleanupAmountRaw: '100',
          lastAction: 'withdraw-lp',
          updatedAt: new Date().toISOString()
        }],
        updatedAt: new Date().toISOString()
      }
    });

    expect(result).toMatchObject({
      action: 'dca-out',
      liveOrderSubmitted: true,
      quote: { stale: true, routeExists: false }
    });
    expect(broadcaster.broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not block a confirmed withdraw-lp when residual cleanup is incomplete', async () => {
    const events: MirrorEvent[] = [];
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        walletLpPositions: []
      },
      accountProvider: {
        readState: vi.fn(async () => ({
          observedAt: new Date(Date.now() + 1_000).toISOString(),
          walletSol: 1.035,
          journalSol: 1.035,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [],
          journalLpPositions: [],
          fills: []
        }))
      },
      mirrorSink: {
        enqueue(event) {
          events.push(event);
        }
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'submitted',
          submissionId: 'sub-close',
          idempotencyKey: intent.intent.idempotencyKey,
          confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
          submissionIds: ['sub-close'],
          confirmationSignatures: ['4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm'],
          batchStatus: 'complete',
          mainExecutionStatus: 'confirmed',
          residualSweepStatus: 'incomplete',
          residualUnsoldMints: ['mint-safe'],
          residualFailureReasons: ['no route'],
          residualEstimatedValueSol: 0.012,
          reason: 'residual token sweep incomplete: mint-safe (no route)'
        })
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
    const fillJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveFillPath);
    const decisionJournal = await readJsonLines<Record<string, unknown>>(
      result.journalPaths.decisionAuditPath
    );
    const incidentJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveIncidentPath);
    const pendingSubmission = await new PendingSubmissionStore(TEST_STATE_DIR).read();
    const orderMirror = events.find((event) => event.type === 'order');

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.reason).toBe('live-order-submitted');
    expect(result.confirmationStatus).toBe('confirmed');
    expect(result.broadcastResult).toMatchObject({
      batchStatus: 'complete',
      mainExecutionStatus: 'confirmed',
      residualSweepStatus: 'incomplete'
    });
    expect(result.submittedActionClosureProven).toBe(true);
    expect(result.fullExitClosureProven).toBe(false);
    expect(orderJournal[0]).toMatchObject({
      side: 'withdraw-lp',
      broadcastStatus: 'submitted',
      confirmationStatus: 'confirmed',
      finality: 'confirmed',
      exitTriggerReason: 'lp-sol-nearly-depleted',
      executionFailureReason: 'residual token sweep incomplete: mint-safe (no route)',
      residualCleanupStatus: 'residual_cleanup_pending',
      residualCleanupValueSol: 0.012
    });
    expect(fillJournal[0]).toMatchObject({
      side: 'withdraw-lp',
      fillAmountSource: 'wallet-delta',
      hasFillEvidence: true,
      actualWalletDeltaSol: 0.035
    });
    expect(decisionJournal[0]).toMatchObject({
      stage: 'broadcast',
      mode: 'LIVE',
      action: 'withdraw-lp',
      reason: 'live-order-submitted',
      confirmationStatus: 'confirmed'
    });
    expect(incidentJournal).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'broadcast',
        severity: 'warning',
        reason: expect.stringContaining('residual_cleanup_pending')
      })
    ]));
    expect(incidentJournal).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        reason: expect.stringContaining('pending-submission-partial-failure')
      })
    ]));
    expect(pendingSubmission).toBeNull();
    expect(orderMirror?.payload).toMatchObject({
      action: 'withdraw-lp',
      confirmationStatus: 'confirmed',
      exitTriggerReason: 'lp-sol-nearly-depleted',
      executionFailureReason: 'residual token sweep incomplete: mint-safe (no route)',
      residualCleanupStatus: 'residual_cleanup_pending',
      residualCleanupValueSol: 0.012
    });
  });
  it('marks claim-fee intents for residual SOL liquidation', async () => {
    const outcomes: LiveCycleOutcomeRecord[] = [];
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      evolutionSink: {
        appendOutcome: async (record) => {
          outcomes.push(record);
        }
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpUnclaimedFeeUsd: 30,
          lpUnclaimedFeeSol: 0.18,
          lpSolDepletedBins: 1
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('claim-fee');
    expect(result.orderIntent).toMatchObject({
      side: 'claim-fee',
      fullPositionExit: false,
      liquidateResidualTokenToSol: true
    });
    expect(orderJournal[0]).toMatchObject({
      side: 'claim-fee',
      fullPositionExit: false,
      liquidateResidualTokenToSol: true
    });
    expect(outcomes).toEqual([]);
  });

  it('does not write confirmed LP fills without trusted fill evidence', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.05,
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: '2026-04-20T00:00:02.000Z'
        })
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.05, slippageBps: 50 }
      }
    });

    const fillJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveFillPath);
    const incidentJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveIncidentPath);

    expect(result.action).toBe('add-lp');
    expect(fillJournal).toEqual([]);
    expect(incidentJournal).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'recovery',
        severity: 'warning',
        reason: 'unknown_pending_reconciliation:missing-fill-evidence'
      })
    ]));
  });

  it('records confirmed fills from post-confirmation wallet delta when account state is available', async () => {
    const accountProvider = {
      readState: vi.fn(async () => ({
        walletSol: 0.943,
        journalSol: 0.943,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      }))
    };

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.05,
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      accountProvider,
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: '2026-04-20T00:00:02.000Z'
        })
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.05, slippageBps: 50 }
      }
    });

    const fillJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveFillPath);

    expect(result.action).toBe('add-lp');
      expect(fillJournal[0]).toMatchObject({
        side: 'add-lp',
        requestedPositionSol: 0.05,
        amount: 0.057,
        filledSol: 0.057,
        actualFilledSol: 0.057,
        actualWalletDeltaSol: -0.057,
        preWalletSol: 1,
        postWalletSol: 0.943,
        fillAmountSource: 'wallet-delta',
        hasFillEvidence: true
    });
  });

  it('trusts an execution broadcaster that already confirmed the main paper execution', async () => {
    const confirmationPoll = vi.fn(async () => {
      throw new Error('paper signatures are not available on the public RPC');
    });
    const accountProvider = {
      readState: vi.fn(async () => ({
        walletSol: 0.94,
        journalSol: 0.94,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      }))
    };

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.05,
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      accountProvider,
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'submitted',
          submissionId: 'paper-submission-1',
          idempotencyKey: intent.intent.idempotencyKey,
          confirmationSignature: 'paper-signature-1',
          mainExecutionStatus: 'confirmed',
          batchStatus: 'complete',
          chainPositionAddress: 'paper-position-1'
        })
      },
      confirmationProvider: {
        poll: confirmationPoll
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.05, slippageBps: 50 }
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
    const fillJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveFillPath);
    const pendingSubmission = await new PendingSubmissionStore(TEST_STATE_DIR).read();

    expect(confirmationPoll).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: 'LIVE',
      action: 'add-lp',
      confirmationStatus: 'confirmed',
      actionIdentity: {
        chainPositionAddress: 'paper-position-1'
      }
    });
    expect(orderJournal[0]).toMatchObject({
      submissionId: 'paper-submission-1',
      confirmationStatus: 'confirmed',
      finality: 'confirmed',
      chainPositionAddress: 'paper-position-1'
    });
    expect(fillJournal[0]).toMatchObject({
      submissionId: 'paper-submission-1',
      side: 'add-lp',
      amount: 0.06,
      hasFillEvidence: true,
      chainPositionAddress: 'paper-position-1'
    });
    expect(pendingSubmission).toBeNull();
  });

  it('keeps submitted execution evidence when confirmation polling fails', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.05,
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'submitted',
          submissionId: 'live-submission-unknown',
          idempotencyKey: intent.intent.idempotencyKey,
          confirmationSignature: 'live-signature-unknown'
        })
      },
      confirmationProvider: {
        poll: vi.fn(async () => {
          throw new Error('rpc timeout');
        })
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.05, slippageBps: 50 }
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
    const pendingSubmission = await new PendingSubmissionStore(TEST_STATE_DIR).read();

    expect(result).toMatchObject({
      mode: 'LIVE',
      action: 'add-lp',
      confirmationStatus: 'unknown',
      liveOrderSubmitted: true
    });
    expect(orderJournal[0]).toMatchObject({
      submissionId: 'live-submission-unknown',
      confirmationStatus: 'unknown',
      finality: 'unknown'
    });
    expect(pendingSubmission).toMatchObject({
      submissionId: 'live-submission-unknown',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      reason: 'confirmation-poll-failed: rpc timeout'
    });
  });

  it('records confirmed close fills only from real post-confirmation wallet delta', async () => {
    const accountProvider = {
      readState: vi.fn(async () => ({
        walletSol: 1.072,
        journalSol: 1.072,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      }))
    };

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.05,
      positionLedger: {
        version: 1,
        updatedAt: '2026-04-20T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:position-1',
          chainPositionAddress: 'position-1',
          activeMint: 'mint-safe',
          activePoolAddress: 'pool-1',
          entryFillSubmissionId: 'managed-open-position-1',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          updatedAt: '2026-04-20T00:00:00.000Z'
        }]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'position-1',
          mint: 'mint-safe',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 165,
          solSide: 'tokenX',
          solDepletedBins: 65,
          currentValueSol: 0.072,
          unclaimedFeeSol: 0,
          hasLiquidity: true
        }],
        journalLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'position-1',
          mint: 'mint-safe',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 165,
          solSide: 'tokenX',
          solDepletedBins: 65,
          currentValueSol: 0.072,
          unclaimedFeeSol: 0,
          hasLiquidity: true
        }],
        fills: []
      },
      accountProvider,
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: '2026-04-20T00:00:02.000Z'
        })
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.05, slippageBps: 50 }
      }
    });

    const fillJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveFillPath);

    expect(result.action).toBe('withdraw-lp');
      expect(fillJournal[0]).toMatchObject({
        side: 'withdraw-lp',
        requestedPositionSol: 0.05,
        amount: 0.072,
        filledSol: 0.072,
        actualFilledSol: 0.072,
        actualWalletDeltaSol: 0.072,
        fillAmountSource: 'wallet-delta',
        hasFillEvidence: true,
        status: 'confirmed'
    });
  });
  it('does not publish a strategy outcome from confirmation alone when the exact LP remains open', async () => {
    const outcomes: LiveCycleOutcomeRecord[] = [];
    const observedAt = new Date(Date.now() + 60_000).toISOString();
    const exactLp = {
      poolAddress: 'pool-1',
      positionAddress: 'pos-1',
      chainPositionAddress: 'pos-1',
      mint: 'mint-safe',
      lowerBinId: 100,
      upperBinId: 168,
      activeBinId: 165,
      solSide: 'tokenX' as const,
      solDepletedBins: 65,
      hasLiquidity: true
    };

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [exactLp],
        journalLpPositions: [],
        fills: []
      },
      accountProvider: {
        readState: async () => ({
          walletSol: 1.05,
          journalSol: 1.05,
          observedAt,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [exactLp],
          journalLpPositions: [],
          fills: []
        })
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: observedAt
        })
      },
      evolutionSink: { appendOutcome: async (record) => { outcomes.push(record); } },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 65 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result).toMatchObject({
      action: 'withdraw-lp',
      confirmationStatus: 'confirmed',
      fullExitClosureProven: false
    });
    expect(outcomes).toEqual([]);
  });

  it('accepts an execution-complete residual boundary while preserving pre-existing same-mint wallet inventory', async () => {
    const postExitObservedAt = new Date(Date.now() + 60_000).toISOString();
    const preExistingToken = {
      mint: 'mint-safe',
      symbol: 'SAFE',
      amount: 500,
      amountRaw: '500'
    };
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [preExistingToken],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'pos-1',
          chainPositionAddress: 'pos-1',
          mint: 'mint-safe',
          solDepletedBins: 65,
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      },
      accountProvider: {
        readState: async () => ({
          observedAt: postExitObservedAt,
          walletSol: 1.08,
          journalSol: 1.08,
          walletTokens: [preExistingToken],
          journalTokens: [],
          walletLpPositions: [],
          journalLpPositions: [],
          fills: []
        })
      },
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'submitted' as const,
          submissionId: 'sub-complete-same-mint-baseline',
          idempotencyKey: intent.intent.idempotencyKey,
          confirmationSignature: 'complete-same-mint-baseline',
          batchStatus: 'complete' as const,
          mainExecutionStatus: 'confirmed' as const,
          residualSweepStatus: 'complete' as const
        })
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: postExitObservedAt
        })
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 65 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result).toMatchObject({
      action: 'withdraw-lp',
      submittedActionClosureProven: true,
      fullExitClosureProven: true,
      orderIntent: { preExitTokenAmountRaw: '500' }
    });
  });

  it('treats explicitly ignored residual dust as resolved after fresh exact LP absence', async () => {
    const postExitObservedAt = new Date(Date.now() + 60_000).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'pos-1',
          chainPositionAddress: 'pos-1',
          mint: 'mint-safe',
          solDepletedBins: 65,
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      },
      accountProvider: {
        readState: async () => ({
          observedAt: postExitObservedAt,
          walletSol: 1.01,
          journalSol: 1.01,
          walletTokens: [{ mint: 'mint-safe', amount: 1, amountRaw: '1' }],
          journalTokens: [],
          walletLpPositions: [],
          journalLpPositions: [],
          fills: []
        })
      },
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'submitted' as const,
          submissionId: 'sub-dust-ignored',
          idempotencyKey: intent.intent.idempotencyKey,
          confirmationSignature: 'dust-ignored',
          mainExecutionStatus: 'confirmed' as const,
          residualSweepStatus: 'dust_ignored' as const,
          residualIgnoredMints: ['mint-safe']
        })
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: postExitObservedAt
        })
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 65 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result).toMatchObject({
      action: 'withdraw-lp',
      submittedActionClosureProven: true,
      fullExitClosureProven: true,
      broadcastResult: { residualSweepStatus: 'dust_ignored' }
    });
  });

  it('emits evolution outcome evidence with a parameter snapshot for LP exits', async () => {
    const outcomes: LiveCycleOutcomeRecord[] = [];
    const openedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const postExitObservedAt = new Date(Date.now() + 60_000).toISOString();
    const beforeAccountState = {
      walletSol: 1,
      journalSol: 1,
      walletTokens: [],
      journalTokens: [],
      walletLpPositions: [{
        poolAddress: 'pool-1',
        positionAddress: 'pos-1',
        chainPositionAddress: 'pos-1',
        mint: 'mint-safe',
        lowerBinId: 100,
        upperBinId: 168,
        activeBinId: 165,
        solSide: 'tokenX' as const,
        solDepletedBins: 65,
        currentValueSol: 0.075,
        liquidityValueSol: 0.075,
        unclaimedFeeValueSol: 0,
        claimedFeeValueSol: 0,
        recoverableRentSol: 0,
        lpTotalValueSol: 0.075,
        unclaimedFeeSol: 0,
        valuationStatus: 'ready' as const,
        valuationCompleteness: 'complete' as const,
        valuationTrust: 'exit_quote' as const,
        valuationReason: '',
        valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote',
        hasLiquidity: true
      }],
      journalLpPositions: [],
      fills: []
    };
    const postAccountState = {
      walletSol: 1.075,
      journalSol: 1.075,
      observedAt: postExitObservedAt,
      walletTokens: [],
      journalTokens: [],
      walletLpPositions: [],
      journalLpPositions: [],
      fills: []
    };

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      captureMode: 'mechanical-soak',
      accountState: beforeAccountState,
      accountProvider: { readState: async () => postAccountState },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: postExitObservedAt
        })
      },
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt,
        chainPositionAddress: 'pos-1',
        updatedAt: openedAt
      },
      evolutionSink: {
        appendOutcome: async (record) => {
          outcomes.push(record);
        }
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpNetPnlPct: -25,
          lpSolDepletedBins: 61,
          lpCurrentValueSol: 0.075,
          lpLiquidityValueSol: 0.075,
          lpUnclaimedFeeValueSol: 0,
          lpClaimedFeeValueSol: 0,
          lpTotalValueSol: 0.075,
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.fullExitClosureProven).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      strategyId: 'new-token-v1',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      positionId: 'pos-1',
      captureMode: 'mechanical-soak',
      action: 'withdraw-lp',
      actualExitReason: 'lp-range-exit:sol-depleted-bins:65/unknown:threshold=60',
      openedAt,
      closedAt: expect.any(String),
      entrySol: 0.1,
      maxObservedDrawdownPct: 0,
      actualExitMetricValue: expect.any(Number),
      lpStopLossNetPnlPctAtEntry: 20,
      lpTakeProfitNetPnlPctAtEntry: 30,
      solDepletionExitBinsAtEntry: 60,
      minBinStepAtEntry: 80,
      parameterSnapshot: {
        lpStopLossNetPnlPct: 20,
        lpTakeProfitNetPnlPct: 30,
        lpSolDepletionExitBins: 60,
        lpMinBinStep: 80,
        maxHoldHours: 8
      },
      exitMetrics: {
        lpNetPnlPct: undefined,
        lpSolDepletedBins: 65,
        valuationTrust: 'exit_quote',
        valuationCompleteness: 'complete',
        settlementEvidence: 'paper-synthetic-lp-lifecycle'
      }
    });
    expect(outcomes[0].actualExitMetricValue).toBe(65);
    expect(outcomes[0].exitMetrics.lpNetPnlPct).toBeUndefined();
    expect(outcomes[0].maxObservedUpsidePct).toBe(0);
  });

  it('swallows evolution outcome sink failures without changing the live-cycle result', async () => {
    const postExitObservedAt = new Date(Date.now() + 60_000).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'pos-1',
          chainPositionAddress: 'pos-1',
          mint: 'mint-safe',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 165,
          solSide: 'tokenX' as const,
          solDepletedBins: 65,
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      },
      accountProvider: {
        readState: async () => ({
          walletSol: 1.08,
          journalSol: 1.08,
          observedAt: postExitObservedAt,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [],
          journalLpPositions: [],
          fills: []
        })
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: postExitObservedAt
        })
      },
      evolutionSink: {
        appendOutcome: async () => {
          throw new Error('outcome-store-unavailable');
        }
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.liveOrderSubmitted).toBe(true);
    expect(result.fullExitClosureProven).toBe(true);
  });

  it('returns hold without collecting a quote when the strategy is not actionable', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: false, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('hold');
    expect(result.quoteCollected).toBe(false);
    expect(result.liveOrderSubmitted).toBe(false);
  });

  it('returns hold without collecting a quote when ingest already provided a block reason', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      context: {
        pool: { address: '', liquidityUsd: 0, blockReason: 'gmgn-safety-script-error' },
        token: { inSession: true, hasSolRoute: false, symbol: '' },
        trader: { hasInventory: false },
        route: {
          hasSolRoute: false,
          expectedOutSol: 0.1,
          slippageBps: 50,
          blockReason: 'gmgn-safety-script-error',
          blockDetails: 'script_error: ModuleNotFoundError'
        }
      }
    });

    const decisionJournal = await readJsonLines<Record<string, unknown>>(
      result.journalPaths.decisionAuditPath
    );

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('hold');
    expect(result.reason).toBe('gmgn-safety-script-error');
    expect(result.quoteCollected).toBe(false);
    expect(result.liveOrderSubmitted).toBe(false);
    expect(decisionJournal[0]).toMatchObject({
      stage: 'engine',
      reason: 'gmgn-safety-script-error'
    });
  });

  it('resolves zero token balance exits before broadcast', async () => {
    const broadcaster = {
      broadcast: vi.fn(async () => {
        throw new Error('should not broadcast zero balance exit');
      })
    };

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      broadcaster,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'withdraw-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        lifecycleState: 'inventory_exit_ready',
        updatedAt: '2026-06-23T00:00:00.000Z'
      } as any,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      }
    });

    const incidentJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveIncidentPath);

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('zero_token_balance_resolved:mint-safe');
    expect(result.liveOrderSubmitted).toBe(false);
    expect(result.quoteCollected).toBe(false);
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    expect(incidentJournal[0]).toMatchObject({
      kind: 'zero_token_balance',
      reason: 'zero_token_balance_resolved:mint-safe'
    });
  });

  it('blocks when the kill switch is engaged', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      killSwitch: new KillSwitch(true),
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('kill-switch-engaged');
    expect(result.liveOrderSubmitted).toBe(false);
  });

  it('does not depend on whitelist membership for live submission', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.liveOrderSubmitted).toBe(true);
  });

  it('blocks new LP opens in flatten_only mode while still allowing exits', async () => {
    const blockedOpen = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      runtimeMode: 'flatten_only',
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    const allowedExit = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      runtimeMode: 'flatten_only',
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(blockedOpen.mode).toBe('BLOCKED');
    expect(blockedOpen.reason).toBe('runtime-flatten-only');
    expect(allowedExit.mode).toBe('LIVE');
    expect(allowedExit.action).toBe('withdraw-lp');
  });

  it('uses configured maxHoldHours for LP full exits', async () => {
    const openedAt = new Date(Date.now() - (9 * 60 * 60 * 1000)).toISOString();

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt,
        chainPositionAddress: 'pos-1',
        updatedAt: openedAt
      } as any,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpNetPnlPct: 5,
          lpCurrentValueSol: 0.105,
          lpLiquidityValueSol: 0.105,
          lpUnclaimedFeeValueSol: 0,
          lpClaimedFeeValueSol: 0,
          lpTotalValueSol: 0.105,
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('max-hold-with-lp-position');
  });

  it('does not force a dca-out for unsellable token dust below the raw amount floor', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.05,
      runtimeMode: 'flatten_only',
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [{
          mint: 'mint-dust',
          symbol: 'DUST',
          amount: 0.000009,
          amountLamports: 9
        }],
        journalTokens: [{
          mint: 'mint-dust',
          symbol: 'DUST',
          amount: 0.000009,
          amountLamports: 9
        }],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.05, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('hold');
    expect(result.reason).toBe('runtime-flatten-only');
    expect(result.liveOrderSubmitted).toBe(false);
  });

  it('does not attach LP identity to residual dca-out orders', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.05,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'withdraw-lp',
        activeMint: 'residual-mint',
        activePoolAddress: 'residual-pool',
        positionId: 'lp-position',
        chainPositionAddress: 'lp-chain-position',
        lifecycleState: 'inventory_exit_ready',
        updatedAt: '2026-06-29T17:00:00.000Z'
      },
      positionLedger: {
        version: 1,
        records: [{
          positionKey: 'chain-position:lp-chain-position',
          chainPositionAddress: 'lp-chain-position',
          activeMint: 'residual-mint',
          activePoolAddress: 'residual-pool',
          lifecycleState: 'inventory_exit_ready',
          lastAction: 'withdraw-lp',
          residualCleanupStatus: 'residual_cleanup_pending',
          residualCleanupAmountRaw: '5000',
          updatedAt: '2026-06-29T17:00:00.000Z'
        }],
        updatedAt: '2026-06-29T17:00:00.000Z'
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [{
          mint: 'residual-mint',
          symbol: 'RES',
          amount: 100,
          currentValueSol: 0.2
        }],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      context: {
        pool: { address: 'residual-pool', liquidityUsd: 10_000 },
        token: { mint: 'residual-mint', inSession: true, hasSolRoute: true, symbol: 'RES' },
        trader: { hasInventory: true, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.05, slippageBps: 50 }
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('dca-out');
    expect(result.actionIdentity?.openIntentId).toBeUndefined();
    expect(result.actionIdentity?.positionId).toBeUndefined();
    expect(result.actionIdentity?.chainPositionAddress).toBeUndefined();
    expect(orderJournal[0]).toMatchObject({
      side: 'sell',
      tokenMint: 'residual-mint',
      inputAmountRaw: '5000'
    });
    expect(result.orderIntent?.poolAddress).toBe('');
    expect(orderJournal[0].poolAddress ?? '').toBe('');
    expect(orderJournal[0].chainPositionAddress).toBeUndefined();
  });

  it('opens LP positions once LP eligibility passed', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: {
          mint: 'mint-safe',
          inSession: true,
          hasSolRoute: true,
          symbol: 'SAFE'
        },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('add-lp');
    expect(result.liveOrderSubmitted).toBe(true);
  });

  it('never lets paper sampling bypass the configured position size cap', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 2,
      captureMode: 'mechanical-soak',
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: {
          mint: 'mint-safe',
          inSession: true,
          hasSolRoute: true,
          symbol: 'SAFE'
        },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 2, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('add-lp');
    expect(result.liveOrderSubmitted).toBe(false);
    expect(result.reason).toBe('live-position-cap-exceeded');
  });

  it('applies the explicit paper-only position cap to a matching paper open', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      captureMode: 'mechanical-soak',
      requestedPositionSol: 1,
      maxLivePositionSolOverride: 1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: {
          mint: 'mint-safe',
          inSession: true,
          hasSolRoute: true,
          symbol: 'SAFE'
        },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('add-lp');
    expect(result.liveOrderSubmitted).toBe(true);
  });

  it('does not reuse stale LP identity when opening a different target', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'withdraw-lp',
        activeMint: 'old-mint',
        activePoolAddress: 'old-pool',
        openIntentId: 'lp-open-intent:old',
        positionId: 'old-position',
        chainPositionAddress: 'old-chain-position',
        lifecycleState: 'closed',
        updatedAt: '2026-06-29T17:00:00.000Z'
      },
      context: {
        pool: { address: 'new-pool', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: {
          mint: 'new-mint',
          inSession: true,
          hasSolRoute: true,
          symbol: 'NEW'
        },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.action).toBe('add-lp');
    expect(result.actionIdentity?.openIntentId).not.toBe('lp-open-intent:old');
    expect(result.actionIdentity?.positionId).toBe('new-pool:new-mint');
    expect(result.orderIntent?.openIntentId).toBe(result.actionIdentity?.openIntentId);
    expect(result.orderIntent?.positionId).toBe('new-pool:new-mint');
  });

  it('does not count exits toward daily spend limits', async () => {
    const stateDir = `${TEST_STATE_DIR}-spending`;

    await rm(stateDir, { recursive: true, force: true });

    const openingResult = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxDailySpendSol: 1
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });
    await new PendingSubmissionStore(stateDir).clear();

    const exitResult = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxDailySpendSol: 1
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    const spendingStore = new SpendingLimitsStore(stateDir);
    const spendingState = await spendingStore.read();

    expect(openingResult.action).toBe('add-lp');
    expect(exitResult.action).toBe('withdraw-lp');
    expect(spendingState.dailySpendSol).toBe(0.1);
    expect(spendingState.orderCount).toBe(1);
  });

  it('durably reserves open-risk spend before the broadcaster can accept the order', async () => {
    const stateDir = `${TEST_STATE_DIR}-spend-before-broadcast`;
    const spendingStore = new SpendingLimitsStore(stateDir);
    let reservationObservedBeforeBroadcast = false;

    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxDailySpendSol: 1
      },
      context: {
        pool: { address: 'pool-spend-before', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-spend-before', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (intent) => {
          const state = await spendingStore.read();
          reservationObservedBeforeBroadcast = state.reservations.some((reservation) =>
            reservation.idempotencyKey === intent.intent.idempotencyKey
            && reservation.requestedSol === 0.1
            && reservation.status === 'reserved'
          );
          return {
            status: 'submitted',
            submissionId: 'submission-spend-before',
            idempotencyKey: intent.intent.idempotencyKey
          };
        }
      }
    });

    expect(result.action).toBe('add-lp');
    expect(result.liveOrderSubmitted).toBe(true);
    expect(reservationObservedBeforeBroadcast).toBe(true);
    expect((await spendingStore.read()).dailySpendSol).toBe(0.1);
  });

  it('releases open-risk spend after a definite not-submitted result', async () => {
    const stateDir = `${TEST_STATE_DIR}-spend-release-not-submitted`;
    const spendingStore = new SpendingLimitsStore(stateDir);

    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxDailySpendSol: 1
      },
      context: {
        pool: { address: 'pool-spend-reject', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-spend-reject', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'failed',
          reason: 'preflight-rejected',
          retryable: false,
          idempotencyKey: intent.intent.idempotencyKey
        })
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.liveOrderSubmitted).toBe(false);
    expect(await spendingStore.read()).toMatchObject({
      dailySpendSol: 0,
      hourlySpendSol: 0,
      orderCount: 0,
      reservations: []
    });
    expect(await new PreparedBroadcastStore(stateDir).read()).toBeNull();
  });

  it('keeps open-risk spend reserved when the broadcast outcome is unknown', async () => {
    const stateDir = `${TEST_STATE_DIR}-spend-keep-unknown`;
    const spendingStore = new SpendingLimitsStore(stateDir);

    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxDailySpendSol: 1
      },
      context: {
        pool: { address: 'pool-spend-unknown', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-spend-unknown', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async () => {
          throw new ExecutionRequestError('broadcast', {
            kind: 'unknown',
            reason: 'broadcast-outcome-unknown',
            retryable: false
          });
        }
      }
    });

    const spendingState = await spendingStore.read();
    expect(result.reason).toBe('broadcast-outcome-unknown');
    expect(spendingState.dailySpendSol).toBe(0.1);
    expect(spendingState.reservations).toHaveLength(1);
    expect(spendingState.reservations[0]).toMatchObject({
      idempotencyKey: result.orderIntent?.idempotencyKey,
      status: 'reserved'
    });
    expect(await new PreparedBroadcastStore(stateDir).read()).not.toBeNull();
  });

  it('marks and clears the WAL when spend reservation fails before broadcast', async () => {
    const stateDir = `${TEST_STATE_DIR}-spend-reservation-failure`;
    const spendingStore = new SpendingLimitsStore(stateDir);
    const testSigner = new TestLiveSigner('reservation-conflict-signer');
    const broadcast = vi.fn();

    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxDailySpendSol: 1
      },
      context: {
        pool: { address: 'pool-spend-conflict', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-spend-conflict', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      signer: {
        sign: async (intent) => {
          await spendingStore.reserveSpend(intent.idempotencyKey, 0.2);
          return testSigner.sign(intent);
        }
      },
      broadcaster: { broadcast }
    });

    expect(result).toMatchObject({
      mode: 'BLOCKED',
      liveOrderSubmitted: false,
      reason: `spending-reservation-conflict:${result.orderIntent?.idempotencyKey}`
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(await new PreparedBroadcastStore(stateDir).read()).toBeNull();
    expect(await spendingStore.read()).toMatchObject({
      dailySpendSol: 0.2,
      orderCount: 1,
      reservations: [{
        idempotencyKey: result.orderIntent?.idempotencyKey,
        requestedSol: 0.2,
        status: 'reserved'
      }]
    });
  });

  it('blocks open-risk actions when the hourly spend limit is exhausted', async () => {
    const stateDir = `${TEST_STATE_DIR}-hourly-spending`;

    await rm(stateDir, { recursive: true, force: true });
    await new SpendingLimitsStore(stateDir).recordSpend(0.45);

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxHourlySpendSol: 0.5,
        maxDailySpendSol: 2
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('hourly-spend-limit-exceeded');
    expect(result.liveOrderSubmitted).toBe(false);
  });

  it('records the pending action for unknown exit submissions', async () => {
    const stateDir = `${TEST_STATE_DIR}-unknown-exit`;

    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async () => {
          throw new ExecutionRequestError('broadcast', {
            kind: 'unknown',
            reason: 'broadcast-outcome-unknown',
            retryable: false
          });
        }
      }
    });

    const pendingSubmission = await new PendingSubmissionStore(stateDir).read();
    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('broadcast-outcome-unknown');
    expect(orderJournal[0]).toMatchObject({
      side: 'withdraw-lp',
      broadcastStatus: 'unknown',
      confirmationStatus: 'unknown'
    });
    expect(String(orderJournal[0].submissionId ?? '')).toBe('');
    expect(pendingSubmission).toMatchObject({
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      orderAction: 'withdraw-lp'
    });
  });

  it('marks signer failures as not submitted instead of pending submission', async () => {
    const stateDir = `${TEST_STATE_DIR}-signer-not-submitted`;

    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      signer: {
        sign: async () => {
          throw new ExecutionRequestError('signer', {
            kind: 'hard',
            reason: 'http-403',
            retryable: false
          });
        }
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
    const pendingSubmission = await new PendingSubmissionStore(stateDir).read();

    expect(result.mode).toBe('BLOCKED');
    expect(result.failureSource).toBe('signer');
    expect(result.liveOrderSubmitted).toBe(false);
    expect(orderJournal).toHaveLength(1);
    expect(orderJournal[0]).toMatchObject({
      side: 'withdraw-lp',
      broadcastStatus: 'not_submitted',
      confirmationStatus: 'unknown'
    });
    expect(String(orderJournal[0].submissionId ?? '')).toBe('');
    expect(String(orderJournal[0].confirmationSignature ?? '')).toBe('');
    expect(pendingSubmission).toBeNull();
  });

  it('marks broadcast failures before submission as not submitted', async () => {
    const stateDir = `${TEST_STATE_DIR}-broadcast-not-submitted`;

    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'failed',
          reason: 'http-403',
          retryable: false,
          idempotencyKey: intent.intent.idempotencyKey
        })
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
    const pendingSubmission = await new PendingSubmissionStore(stateDir).read();

    expect(result.mode).toBe('BLOCKED');
    expect(result.failureSource).toBe('broadcast');
    expect(result.liveOrderSubmitted).toBe(false);
    expect(orderJournal).toHaveLength(1);
    expect(orderJournal[0]).toMatchObject({
      side: 'withdraw-lp',
      broadcastStatus: 'not_submitted',
      confirmationStatus: 'unknown'
    });
    expect(String(orderJournal[0].submissionId ?? '')).toBe('');
    expect(String(orderJournal[0].confirmationSignature ?? '')).toBe('');
    expect(pendingSubmission).toBeNull();
  });

  it('treats a structured execution-policy 409 as not submitted and keeps the LP exit retryable', async () => {
    const stateDir = `${TEST_STATE_DIR}-policy-mismatch-not-submitted`;
    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      accountState: {
        observedAt: new Date().toISOString(),
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'pos-1',
          mint: 'mint-safe',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 168,
          solSide: 'tokenX',
          solDepletedBins: 68,
          currentValueSol: 0.1,
          liquidityValueSol: 0.1,
          unclaimedFeeValueSol: 0,
          claimedFeeValueSol: 0,
          lpTotalValueSol: 0.1,
          unclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote',
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async () => {
          throw new ExecutionRequestError('broadcast', {
            kind: 'hard',
            reason: 'http-409',
            retryable: false
          }, undefined, 409, 'execution policy mismatch: signed intent requires simulate-only');
        }
      }
    });

    expect(result).toMatchObject({
      mode: 'BLOCKED',
      action: 'withdraw-lp',
      reason: 'http-409',
      liveOrderSubmitted: false,
      nextLifecycleState: 'open'
    });
    expect(await new PendingSubmissionStore(stateDir).read()).toBeNull();
    expect(await new PreparedBroadcastStore(stateDir).read()).toBeNull();
  });

  it('keeps an idempotency-pending 409 fail-closed because acceptance is unknown', async () => {
    const stateDir = `${TEST_STATE_DIR}-idempotency-pending-unknown`;
    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async () => {
          throw new ExecutionRequestError('broadcast', {
            kind: 'hard',
            reason: 'http-409',
            retryable: false
          }, undefined, 409, 'idempotency key pending: request is reserved');
        }
      }
    });

    expect(result).toMatchObject({
      mode: 'BLOCKED',
      action: 'withdraw-lp',
      reason: 'http-409',
      liveOrderSubmitted: false
    });
    expect(await new PendingSubmissionStore(stateDir).read()).toMatchObject({
      submissionId: '',
      confirmationStatus: 'unknown',
      reason: 'http-409'
    });
    expect(await new PreparedBroadcastStore(stateDir).read()).not.toBeNull();
  });

  it('classifies missing LP position exits as already closed without pending submission', async () => {
    const stateDir = `${TEST_STATE_DIR}-position-already-closed`;

    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: {
        broadcast: async (intent) => ({
          status: 'failed',
          reason: 'Position not found for pool',
          retryable: true,
          idempotencyKey: intent.intent.idempotencyKey
        })
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
    const incidentJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveIncidentPath);
    const pendingSubmission = await new PendingSubmissionStore(stateDir).read();

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('position-already-closed:Position not found for pool');
    expect(result.liveOrderSubmitted).toBe(false);
    expect(orderJournal[0]).toMatchObject({
      side: 'withdraw-lp',
      broadcastStatus: 'not_submitted',
      confirmationStatus: 'unknown'
    });
    expect(incidentJournal[0]).toMatchObject({
      reason: 'position-already-closed:Position not found for pool',
      severity: 'warning'
    });
    expect(pendingSubmission).toBeNull();
  });

  it('allows exits even when the requested position exceeds the live cap', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.5,
      positionState: activeLpPositionState({ entrySol: 0.5 }),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.5, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.liveOrderSubmitted).toBe(true);
    expect(result.orderIntent?.fullPositionExit).toBe(true);
  });

  it('emits mirror events without blocking the live cycle result', async () => {
    const events: MirrorEvent[] = [];

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState(),
      mirrorSink: {
        enqueue(event) {
          events.push(event);
        }
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(events.some((event) => event.type === 'order')).toBe(true);
    expect(events.some((event) => event.type === 'fill')).toBe(false);
    expect(events.some((event) => event.type === 'cycle_run')).toBe(true);
  });

  it('does not derive lpNetPnlPct from untrusted live position value snapshots', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        lifecycleState: 'open',
        lastClosedMint: '',
        lastClosedAt: '',
        updatedAt: '2026-03-22T00:00:00.000Z',
        entrySol: 1
      } as any,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: {
            hasInventory: true,
            hasLpPosition: true,
            lpNetPnlPct: 35,
            lpCurrentValueSol: 0.72,
            lpUnclaimedFeeSol: 0.03
          },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

      expect(result.mode).toBe('BLOCKED');
      expect(result.action).toBe('hold');
      expect(result.reason).toBe('hold');
      expect(result.context.trader.lpNetPnlPct).toBeUndefined();
    });

  it('uses an explicitly labeled active-bin model for mechanical paper take-profit without creating PnL evidence', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const postExitObservedAt = new Date(Date.now() + 60_000).toISOString();
    const outcomes: LiveCycleOutcomeRecord[] = [];
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 1,
      captureMode: 'mechanical-soak',
      positionState: activeLpPositionState({ entrySol: 1, openedAt }),
      accountState: paperModeledLpAccountState(1.31),
      accountProvider: {
        readState: async () => ({
          observedAt: postExitObservedAt,
          walletSol: 2,
          journalSol: 2,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [],
          journalLpPositions: [],
          fills: []
        })
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: postExitObservedAt
        })
      },
      evolutionSink: {
        appendOutcome: async (record) => { outcomes.push(record); }
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 1, slippageBps: 50 }
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('lp-take-profit');
    expect(result.orderIntent?.executionPolicy).toBe('simulate-only');
    expect(result.context.trader.lpModeledNetPnlPct).toBeCloseTo(31, 10);
    expect(result.context.trader.lpModeledPnlSource).toBe('paper-shadow-dlmm-active-bin-modeled');
    expect(result.context.trader.lpNetPnlPct).toBeUndefined();
    expect(result.context.trader.valuationTrust).toBe('fallback_display');
    expect(result.context.trader.valuationCompleteness).toBe('untrusted');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].exitMetrics).toMatchObject({
      lpNetPnlPct: undefined,
      valuationTrust: 'fallback_display',
      valuationCompleteness: 'untrusted',
      settlementEvidence: 'paper-synthetic-lp-lifecycle'
    });
    expect(outcomes[0].maxObservedUpsidePct).toBe(0);
  });

  it('uses the same LP exit policy for an explicitly labeled mechanical paper stop-loss', async () => {
    const openedAt = new Date(Date.now() - (60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 1,
      captureMode: 'mechanical-soak',
      positionState: activeLpPositionState({ entrySol: 1, openedAt }),
      accountState: paperModeledLpAccountState(0.75),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 1, slippageBps: 50 }
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('lp-stop-loss');
    expect(result.orderIntent?.executionPolicy).toBe('simulate-only');
    expect(result.context.trader.lpModeledNetPnlPct).toBeCloseTo(-25, 10);
    expect(result.context.trader.lpNetPnlPct).toBeUndefined();
  });

  it('never lets the paper active-bin model trigger live TP/SL', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 1,
      captureMode: 'live',
      positionState: activeLpPositionState({ entrySol: 1, openedAt }),
      accountState: paperModeledLpAccountState(0.75),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 1, slippageBps: 50 }
      }
    });

    expect(result.action).toBe('hold');
    expect(result.audit.reason).not.toBe('lp-stop-loss');
    expect(result.context.trader.lpModeledNetPnlPct).toBeUndefined();
    expect(result.context.trader.lpNetPnlPct).toBeUndefined();
    expect(result.orderIntent).toBeUndefined();
  });

  it('keeps claim-fee disabled when paper only has an active-bin value and no modeled fee evidence', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 1,
      captureMode: 'mechanical-soak',
      positionState: activeLpPositionState({ entrySol: 1, openedAt }),
      accountState: paperModeledLpAccountState(1.05),
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpUnclaimedFeeUsd: 10_000 },
        route: { hasSolRoute: true, expectedOutSol: 1, slippageBps: 50 }
      }
    });

    expect(result.action).toBe('hold');
    expect(result.audit.reason).not.toBe('lp-claim-fee-threshold');
    expect(result.context.trader.lpUnclaimedFeeUsd).toBeUndefined();
    expect(result.context.trader.lpModeledNetPnlPct).toBeCloseTo(5, 10);
    expect(result.orderIntent).toBeUndefined();
  });

  it('does not derive lpNetPnlPct from complete context valuation without provider quote evidence', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open',
        openedAt,
        lastClosedMint: '',
        lastClosedAt: '',
        updatedAt: openedAt,
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open'
      } as any,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpCurrentValueSol: 0.16,
          lpLiquidityValueSol: 0.16,
          lpUnclaimedFeeValueSol: 0,
          lpClaimedFeeValueSol: 0,
          lpTotalValueSol: 0.16,
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.action).toBe('hold');
    expect(result.audit.reason).not.toBe('lp-take-profit');
    expect(result.context.trader.lpNetPnlPct).toBeUndefined();
  });

  it('derives lpNetPnlPct from trusted withdraw-simulation valuations and triggers take profit', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        chainPositionAddress: 'position-1',
        lifecycleState: 'open',
        openedAt,
        lastClosedMint: '',
        lastClosedAt: '',
        updatedAt: '2026-03-22T00:00:00.000Z',
        entrySol: 1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open'
      } as any,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'position-1',
          mint: 'mint-safe',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 120,
          solSide: 'tokenX',
          solDepletedBins: 20,
          currentValueSol: 1.31,
          liquidityValueSol: 1.31,
          unclaimedFeeValueSol: 0,
          claimedFeeValueSol: 0,
          lpTotalValueSol: 1.31,
          unclaimedFeeSol: 0.5,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationReason: '',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        }],
        journalLpPositions: [],
        fills: []
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toContain('lp-take-profit');
    expect(result.context.trader.lpNetPnlPct).toBeCloseTo(31, 10);
  });

  it('uses wallet-delta add-lp fill instead of requested entry for LP take-profit gating', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.02,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-fugu',
        activePoolAddress: 'pool-fugu',
        chainPositionAddress: 'position-fugu',
        lifecycleState: 'open',
        openedAt,
        updatedAt: openedAt,
        entrySol: 0.02
      } as any,
      context: {
        pool: { address: 'pool-fugu', liquidityUsd: 10_000 },
        token: { mint: 'mint-fugu', inSession: true, hasSolRoute: true, symbol: 'FUGU' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.02, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-fugu',
          positionAddress: 'position-fugu',
          mint: 'mint-fugu',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 120,
          solSide: 'tokenX',
          solDepletedBins: 20,
          currentValueSol: 0.04,
          liquidityValueSol: 0.04,
          unclaimedFeeValueSol: 0,
          claimedFeeValueSol: 0,
          lpTotalValueSol: 0.04,
          unclaimedFeeSol: 0,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationReason: '',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        }],
        journalLpPositions: [],
        fills: [{
          submissionId: 'sub-fugu-open',
          chainPositionAddress: 'position-fugu',
            mint: 'mint-fugu',
            side: 'add-lp',
            amount: 0.077416045,
            actualFilledSol: 0.077416045,
            actualWalletDeltaSol: 0.077416045,
            fillAmountSource: 'wallet-delta',
            hasFillEvidence: true,
            recordedAt: openedAt
        }]
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('lp-stop-loss');
    expect(result.audit.reason).not.toBe('lp-take-profit');
    expect(result.context.trader.lpNetPnlPct).toBeCloseTo(-48.33112, 5);
  });

  it('uses the unique trusted pool-mint open fill instead of stale LP entry state for stop-loss gating', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.08,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-stale-entry',
        activePoolAddress: 'pool-stale-entry',
        positionId: 'stale-position',
        lifecycleState: 'open',
        openedAt,
        updatedAt: openedAt,
        entrySol: 0.137416044,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'stale-open'
      } as any,
      context: {
        pool: { address: 'pool-stale-entry', liquidityUsd: 10_000 },
        token: { mint: 'mint-stale-entry', inSession: true, hasSolRoute: true, symbol: 'STALE' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.08, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-stale-entry',
          positionAddress: 'current-chain-position',
          mint: 'mint-stale-entry',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 120,
          solSide: 'tokenX',
          solDepletedBins: 2,
          currentValueSol: 0.07740664,
          liquidityValueSol: 0.019999289,
          unclaimedFeeValueSol: 0.000001271,
          claimedFeeValueSol: 0,
          recoverableRentSol: 0.05740608,
          unclaimedFeeSol: 0.000001271,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationReason: '',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote+position-account-rent'
        }],
        journalLpPositions: [],
        fills: [{
          submissionId: 'real-open',
          chainPositionAddress: 'current-chain-position',
          positionId: 'current-chain-position',
          mint: 'mint-stale-entry',
          side: 'add-lp',
          amount: 0.077416045,
          actualFilledSol: 0.077416045,
          actualWalletDeltaSol: -0.077416045,
          fillAmountSource: 'wallet-delta',
          hasFillEvidence: true,
          recordedAt: new Date(Date.parse(openedAt) - 7 * 60 * 1000).toISOString()
        }]
      }
    });

    expect(result.action).toBe('hold');
    expect(result.audit.reason).not.toContain('lp-stop-loss');
    expect(result.context.trader.lpEntryTradingSol).toBeCloseTo(0.020009965, 9);
    expect(result.context.trader.lpTradingValueSol).toBeCloseTo(0.02000056, 9);
    expect(result.context.trader.lpNetPnlPct).toBeCloseTo(-0.047, 3);
  });

  it('does not trigger false take profit when actual LP fill is below threshold profit', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.08,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-partial',
        activePoolAddress: 'pool-partial',
        chainPositionAddress: 'position-partial',
        lifecycleState: 'open',
        openedAt,
        updatedAt: openedAt,
        entrySol: 0.08
      } as any,
      context: {
        pool: { address: 'pool-partial', liquidityUsd: 10_000 },
        token: { mint: 'mint-partial', inSession: true, hasSolRoute: true, symbol: 'PART' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpCurrentValueSol: 0.160108238,
          lpLiquidityValueSol: 0.160108238,
          lpUnclaimedFeeValueSol: 0,
          lpClaimedFeeValueSol: 0,
          lpTotalValueSol: 0.160108238,
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.08, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-partial',
          positionAddress: 'position-partial',
          mint: 'mint-partial',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 120,
          solSide: 'tokenX',
          solDepletedBins: 20,
          currentValueSol: 0.160108238,
          liquidityValueSol: 0.160108238,
          unclaimedFeeValueSol: 0,
          claimedFeeValueSol: 0,
          lpTotalValueSol: 0.160108238,
          unclaimedFeeSol: 0,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationReason: '',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        }],
        journalLpPositions: [],
        fills: [{
          submissionId: 'sub-partial-open',
          chainPositionAddress: 'position-partial',
            mint: 'mint-partial',
            side: 'add-lp',
            amount: 0.137416044,
            actualFilledSol: 0.137416044,
            actualWalletDeltaSol: 0.137416044,
            fillAmountSource: 'wallet-delta',
            hasFillEvidence: true,
            recordedAt: openedAt
        }]
      }
    });

      expect(result.action).toBe('hold');
      expect(result.audit.reason).not.toBe('lp-take-profit');
      expect(result.orderIntent).toBeUndefined();
      expect(result.context.trader.lpNetPnlPct).toBeCloseTo(16.5135, 5);
  });

  it('counts recoverable LP position rent before triggering PnL stop loss', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.08,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-rent',
        activePoolAddress: 'pool-rent',
        chainPositionAddress: 'position-rent',
        lifecycleState: 'open',
        openedAt,
        updatedAt: openedAt,
        entrySol: 0.137416044,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-rent-open'
      } as any,
      context: {
        pool: { address: 'pool-rent', liquidityUsd: 10_000 },
        token: { mint: 'mint-rent', inSession: true, hasSolRoute: true, symbol: 'RENT' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.08, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-rent',
          positionAddress: 'position-rent',
          mint: 'mint-rent',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 120,
          solSide: 'tokenX',
          solDepletedBins: 20,
          currentValueSol: 0.079998393,
          liquidityValueSol: 0.079998393,
          unclaimedFeeValueSol: 0,
          claimedFeeValueSol: 0,
          recoverableRentSol: 0.057416045,
          unclaimedFeeSol: 0,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationReason: '',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote+position-account-rent'
        }],
        journalLpPositions: [],
        fills: [{
          submissionId: 'sub-rent-open',
          chainPositionAddress: 'position-rent',
          mint: 'mint-rent',
          side: 'add-lp',
          amount: 0.137416044,
          actualFilledSol: 0.137416044,
          actualWalletDeltaSol: 0.137416044,
          fillAmountSource: 'wallet-delta',
          hasFillEvidence: true,
          recordedAt: openedAt
        }]
      }
    });

    expect(result.action).toBe('hold');
    expect(result.audit.reason).not.toBe('lp-stop-loss');
    expect(result.context.trader.lpTotalValueSol).toBeCloseTo(0.137414438, 9);
    expect(result.context.trader.lpTradingValueSol).toBeCloseTo(0.079998393, 9);
    expect(result.context.trader.lpEntryTradingSol).toBeCloseTo(0.079999999, 9);
    expect(result.context.trader.lpNetPnlPct).toBeCloseTo(-0.0020075, 6);
  });

  it('uses rent-excluded pool capital for LP stop loss thresholds', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-rent-stop',
        activePoolAddress: 'pool-rent-stop',
        chainPositionAddress: 'position-rent-stop',
        lifecycleState: 'open',
        openedAt,
        updatedAt: openedAt,
        entrySol: 0.157416045,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-rent-stop-open'
      } as any,
      context: {
        pool: { address: 'pool-rent-stop', liquidityUsd: 10_000 },
        token: { mint: 'mint-rent-stop', inSession: true, hasSolRoute: true, symbol: 'RST' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-rent-stop',
          positionAddress: 'position-rent-stop',
          mint: 'mint-rent-stop',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 120,
          solSide: 'tokenX',
          solDepletedBins: 20,
          currentValueSol: 0.13630608,
          liquidityValueSol: 0.0789,
          unclaimedFeeValueSol: 0,
          claimedFeeValueSol: 0,
          recoverableRentSol: 0.05740608,
          unclaimedFeeSol: 0,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationReason: '',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote+position-account-rent'
        }],
        journalLpPositions: [],
        fills: [{
          submissionId: 'sub-rent-stop-open',
          chainPositionAddress: 'position-rent-stop',
          mint: 'mint-rent-stop',
          side: 'add-lp',
          amount: 0.157416045,
          actualFilledSol: 0.157416045,
          actualWalletDeltaSol: 0.157416045,
          fillAmountSource: 'wallet-delta',
          hasFillEvidence: true,
          recordedAt: openedAt
        }]
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toContain('lp-stop-loss');
    expect(result.context.trader.lpTradingValueSol).toBeCloseTo(0.0789, 9);
    expect(result.context.trader.lpEntryTradingSol).toBeCloseTo(0.100009965, 9);
    expect(result.context.trader.lpNetPnlPct).toBeLessThan(-20);
  });

  it('does not trust wallet-delta sourced LP open fills without explicit fill evidence', async () => {
      const openedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const result = await runLiveCycle({
        strategy: 'new-token-v1',
        journalRootDir: TEST_JOURNAL_DIR,
        stateRootDir: TEST_STATE_DIR,
        requestedPositionSol: 0.02,
        positionState: {
          allowNewOpens: true,
          flattenOnly: false,
          lastAction: 'add-lp',
          activeMint: 'mint-no-evidence',
          activePoolAddress: 'pool-no-evidence',
          chainPositionAddress: 'position-no-evidence',
          lifecycleState: 'open',
          entrySol: 0.02,
          openedAt,
          updatedAt: openedAt
        },
        context: {
          pool: { address: 'pool-no-evidence', liquidityUsd: 10_000 },
          token: { mint: 'mint-no-evidence', inSession: true, hasSolRoute: true, symbol: 'NEV' },
          trader: {
            hasInventory: true,
            hasLpPosition: true,
            lpCurrentValueSol: 0.160108238,
            lpUnclaimedFeeSol: 0,
            valuationStatus: 'ready',
            valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
          },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        },
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [{
            poolAddress: 'pool-no-evidence',
            positionAddress: 'position-no-evidence',
            mint: 'mint-no-evidence',
            lowerBinId: 100,
            upperBinId: 168,
            activeBinId: 120,
            solSide: 'tokenX',
            solDepletedBins: 20,
            currentValueSol: 0.160108238,
            unclaimedFeeSol: 0,
            hasLiquidity: true,
            valuationStatus: 'ready',
            valuationReason: '',
            valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
          }],
          journalLpPositions: [],
          fills: [{
            submissionId: 'sub-no-evidence-open',
            chainPositionAddress: 'position-no-evidence',
            mint: 'mint-no-evidence',
            side: 'add-lp',
            amount: 0.137416044,
            actualFilledSol: 0.137416044,
            actualWalletDeltaSol: 0.137416044,
            fillAmountSource: 'wallet-delta',
            recordedAt: openedAt
          }]
        }
      });

      expect(result.action).toBe('hold');
      expect(result.audit.reason).not.toBe('lp-take-profit');
      expect(result.context.trader.lpNetPnlPct).toBeUndefined();
    });

    it('does not use journal-backed LP valuation snapshots to trigger same-mint take profit', async () => {
      const baseFillPath = join(TEST_JOURNAL_DIR, 'new-token-v1-live-fills.jsonl');
      const oldRecordedAt = new Date(Date.now() - (30 * 60 * 60 * 1000)).toISOString();
      const currentRecordedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();

    await appendJsonLine(baseFillPath, {
      submissionId: 'old-open',
      mint: 'mint-shared',
      side: 'add-lp',
      amount: 1,
      recordedAt: oldRecordedAt
    }, {
      rotateDaily: true,
      now: new Date(oldRecordedAt)
    });

    await appendJsonLine(baseFillPath, {
      submissionId: 'current-open',
      mint: 'mint-shared',
      side: 'add-lp',
      amount: 0.5,
      recordedAt: currentRecordedAt
    }, {
      rotateDaily: true,
      now: new Date(currentRecordedAt)
    });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-shared',
        activePoolAddress: 'pool-shared',
        lifecycleState: 'open',
        entrySol: 0.5,
        openedAt: currentRecordedAt,
        updatedAt: currentRecordedAt
      } as any,
      context: {
        pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
        token: { mint: '', inSession: true, hasSolRoute: false, symbol: '', blockReason: 'no-selected-candidate' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
      },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          {
            poolAddress: 'pool-shared',
            positionAddress: 'pos-current',
            mint: 'mint-shared',
            lowerBinId: 200,
            upperBinId: 268,
            activeBinId: 210,
            solSide: 'tokenX',
            solDepletedBins: 10,
            currentValueSol: 0.7,
            unclaimedFeeSol: 0,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-shared',
            positionAddress: 'pos-current',
            mint: 'mint-shared',
            lowerBinId: 200,
            upperBinId: 268,
            activeBinId: 210,
            solSide: 'tokenX',
            solDepletedBins: 10,
            currentValueSol: 0.7,
            unclaimedFeeSol: 0,
            hasLiquidity: true
          }
        ],
        fills: []
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('hold');
    expect(result.reason).toBe('no-selected-candidate');
    expect(result.orderIntent).toBeUndefined();
  });

  it('does not treat legacy persisted LP entry as trusted take-profit evidence without a source', async () => {
    const openedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'hold',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        openedAt,
        updatedAt: openedAt
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpNetPnlPct: 35,
          lpCurrentValueSol: 0.135,
          lpLiquidityValueSol: 0.135,
          lpUnclaimedFeeValueSol: 0,
          lpClaimedFeeValueSol: 0,
          lpTotalValueSol: 0.135,
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.action).toBe('hold');
    expect(result.audit.reason).not.toBe('lp-take-profit');
    expect(result.context.trader.lpNetPnlPct).toBeUndefined();
  });

  it('uses trusted persisted LP entry source for take-profit gating', async () => {
    const openedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'hold',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt,
        chainPositionAddress: 'pos-1',
        updatedAt: openedAt
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpNetPnlPct: 35,
          lpCurrentValueSol: 0.135,
          lpLiquidityValueSol: 0.135,
          lpUnclaimedFeeValueSol: 0,
          lpClaimedFeeValueSol: 0,
          lpTotalValueSol: 0.135,
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('lp-take-profit');
  });

  it('routes same-mint LP exits to the persisted active pool instead of the selected candidate pool', async () => {
    const openedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-shared',
        activePoolAddress: 'pool-open',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt,
        chainPositionAddress: 'pos-open',
        updatedAt: openedAt
      },
      context: {
        pool: { address: 'pool-selected-other', liquidityUsd: 10_000 },
        token: { mint: 'mint-shared', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpNetPnlPct: 35,
          lpCurrentValueSol: 0.14,
          lpLiquidityValueSol: 0.14,
          lpUnclaimedFeeValueSol: 0,
          lpClaimedFeeValueSol: 0,
          lpTotalValueSol: 0.14,
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50, poolAddress: 'pool-selected-other' }
      }
    });

    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('lp-take-profit');
    expect(result.orderIntent?.poolAddress).toBe('pool-open');
    expect(orderJournal[0]).toMatchObject({
      side: 'withdraw-lp',
      poolAddress: 'pool-open',
      tokenMint: 'mint-shared'
    });
  });

  it('uses the active LP entry size for same-mint withdraws when the selected candidate amount differs', async () => {
    const openedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.02,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-shared',
        activePoolAddress: 'pool-open',
        lifecycleState: 'open',
        entrySol: 0.08,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt,
        chainPositionAddress: 'pos-open',
        updatedAt: openedAt
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: new Date().toISOString()
        })
      },
      context: {
        pool: { address: 'pool-selected-other', liquidityUsd: 10_000 },
        token: { mint: 'mint-shared', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpNetPnlPct: 35,
          lpCurrentValueSol: 0.16,
          lpLiquidityValueSol: 0.16,
          lpUnclaimedFeeValueSol: 0,
          lpClaimedFeeValueSol: 0,
          lpTotalValueSol: 0.16,
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.02, slippageBps: 50, poolAddress: 'pool-selected-other' }
      }
      });

      const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
      const quoteJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.quoteJournalPath);
      const fillJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveFillPath);
      const incidentJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveIncidentPath);
      const decisionJournal = await readJsonLines<Record<string, unknown>>(
        result.journalPaths.decisionAuditPath
      );

      expect(result.mode).toBe('LIVE');
      expect(result.action).toBe('withdraw-lp');
      expect(result.orderIntent).toMatchObject({
        poolAddress: 'pool-open',
        outputSol: 0.08,
        fullPositionExit: true
      });
      expect(orderJournal[0]).toMatchObject({
        side: 'withdraw-lp',
        poolAddress: 'pool-open',
        outputSol: 0.08,
        requestedPositionSol: 0.08,
        quotedOutputSol: 0.08
      });
      expect(quoteJournal[0]).toMatchObject({
        poolAddress: 'pool-open',
        outputSol: 0.08,
        requestedPositionSol: 0.08
      });
      expect(fillJournal).toEqual([]);
      expect(incidentJournal).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stage: 'recovery',
          severity: 'warning',
          reason: 'unknown_pending_reconciliation:missing-fill-evidence'
        })
      ]));
      expect(decisionJournal[0]).toMatchObject({
        action: 'withdraw-lp',
        requestedPositionSol: 0.08,
        quoteOutputSol: 0.08,
        confirmationStatus: 'confirmed'
      });
      expect(result.nextLifecycleState).toBe('lp_exit_pending');
    });

    it('does not use unbound journal LP fills to override bin-depletion exits', async () => {
      const baseFillPath = join(TEST_JOURNAL_DIR, 'new-token-v1-live-fills.jsonl');
      const oldRecordedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const newRecordedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      await appendJsonLine(baseFillPath, {
        submissionId: 'old-open',
        mint: 'mint-old',
        side: 'add-lp',
        amount: 1,
        recordedAt: oldRecordedAt
      }, {
        rotateDaily: true,
        now: new Date(oldRecordedAt)
      });

      await appendJsonLine(baseFillPath, {
        submissionId: 'new-open',
        mint: 'mint-new',
        side: 'add-lp',
        amount: 1,
        recordedAt: newRecordedAt
      }, {
        rotateDaily: true,
        now: new Date(newRecordedAt)
      });

      await appendJsonLine(baseFillPath, {
        submissionId: 'new-open-bound',
        mint: 'mint-new',
        side: 'add-lp',
        amount: 0.2,
        filledSol: 0.2,
        actualFilledSol: 0.2,
        actualWalletDeltaSol: 0.2,
        fillAmountSource: 'wallet-delta',
        hasFillEvidence: true,
        positionId: 'pos-new',
        chainPositionAddress: 'pos-new',
        poolAddress: 'pool-new',
        recordedAt: newRecordedAt
      }, {
        rotateDaily: true,
        now: new Date(newRecordedAt)
      });

      const result = await runLiveCycle({
        strategy: 'new-token-v1',
        journalRootDir: TEST_JOURNAL_DIR,
        stateRootDir: TEST_STATE_DIR,
        requestedPositionSol: 0.1,
        positionState: {
          allowNewOpens: true,
          flattenOnly: false,
          lastAction: 'add-lp',
          activeMint: 'mint-old',
          activePoolAddress: 'pool-old',
          chainPositionAddress: 'pos-old',
          lifecycleState: 'open',
          entrySol: 0.6,
          entrySolSource: 'actual_fill',
          entryFillSubmissionId: 'old-open',
          openedAt: oldRecordedAt,
          updatedAt: oldRecordedAt
        },
        context: {
          pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          token: { mint: '', inSession: true, hasSolRoute: false, symbol: '', blockReason: 'no-selected-candidate' },
          trader: {
            hasInventory: true,
            hasLpPosition: true,
            lpNetPnlPct: 40,
            lpCurrentValueSol: 0.84,
            lpUnclaimedFeeSol: 0,
            valuationStatus: 'ready',
            valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote'
          },
          route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
        },
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-new',
              positionAddress: 'pos-new',
              mint: 'mint-new',
              lowerBinId: 100,
              upperBinId: 168,
              activeBinId: 165,
              solSide: 'tokenX',
              solDepletedBins: 65,
              currentValueSol: 0.97,
              unclaimedFeeSol: 0.01,
              hasLiquidity: true
            },
            {
              poolAddress: 'pool-old',
              positionAddress: 'pos-old',
              mint: 'mint-old',
              lowerBinId: 200,
              upperBinId: 268,
              activeBinId: 210,
              solSide: 'tokenX',
              solDepletedBins: 10,
              currentValueSol: 0.72,
              unclaimedFeeSol: 0.03,
              hasLiquidity: true
            }
          ],
          journalLpPositions: [
            {
              poolAddress: 'pool-new',
              positionAddress: 'pos-new',
              mint: 'mint-new',
              lowerBinId: 100,
              upperBinId: 168,
              activeBinId: 165,
              solSide: 'tokenX',
              solDepletedBins: 65,
              currentValueSol: 0.97,
              unclaimedFeeSol: 0.01,
              hasLiquidity: true
            },
            {
              poolAddress: 'pool-old',
              positionAddress: 'pos-old',
              mint: 'mint-old',
              lowerBinId: 200,
              upperBinId: 268,
              activeBinId: 210,
              solSide: 'tokenX',
              solDepletedBins: 10,
              currentValueSol: 0.72,
              unclaimedFeeSol: 0.03,
              hasLiquidity: true
            }
          ],
          fills: []
        }
      });

      expect(result.mode).toBe('LIVE');
      expect(result.action).toBe('withdraw-lp');
      expect(result.audit.reason).toContain('sol-depleted-bins');
      expect(result.orderIntent?.poolAddress).toBe('pool-new');
      expect(result.orderIntent).toMatchObject({
        poolAddress: 'pool-new',
        tokenMint: 'mint-new',
        outputSol: 0.2,
        fullPositionExit: true
      });
      expect(result.context.trader.lpNetPnlPct).toBeUndefined();
      const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
      expect(orderJournal[0]).toMatchObject({
        side: 'withdraw-lp',
        poolAddress: 'pool-new',
        tokenMint: 'mint-new',
        chainPositionAddress: 'pos-new',
        requestedPositionSol: 0.2,
        outputSol: 0.2
      });
    });

  it('uses chainPositionAddress for paper overlay multi-LP exits when positionAddress is absent', async () => {
    const oldRecordedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-old',
        activePoolAddress: 'pool-old',
        chainPositionAddress: 'pos-old',
        lifecycleState: 'open',
        entrySol: 1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'old-open',
        openedAt: oldRecordedAt,
        updatedAt: oldRecordedAt
      },
      context: {
        pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
        token: { mint: '', inSession: true, hasSolRoute: false, symbol: '', blockReason: 'no-selected-candidate' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpCurrentValueSol: 1,
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationSource: 'paper-dry-run-overlay'
        },
        route: { hasSolRoute: false, expectedOutSol: 1, slippageBps: 50, blockReason: 'no-selected-candidate' }
      },
      accountState: {
        walletSol: 999_998,
        journalSol: 999_998,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          {
            poolAddress: 'pool-paper',
            chainPositionAddress: 'paper-chain-position',
            mint: 'mint-paper',
            lowerBinId: 0,
            upperBinId: 68,
            activeBinId: 67,
            solSide: 'tokenX',
            solDepletedBins: 65,
            currentValueSol: 1,
            unclaimedFeeSol: 0,
            hasLiquidity: true
          },
          {
            poolAddress: 'pool-old',
            positionAddress: 'pos-old',
            chainPositionAddress: 'pos-old',
            mint: 'mint-old',
            lowerBinId: 0,
            upperBinId: 68,
            activeBinId: 34,
            solSide: 'tokenX',
            solDepletedBins: 0,
            currentValueSol: 1,
            unclaimedFeeSol: 0,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-paper',
            chainPositionAddress: 'paper-chain-position',
            mint: 'mint-paper',
            lowerBinId: 0,
            upperBinId: 68,
            activeBinId: 67,
            solSide: 'tokenX',
            solDepletedBins: 65,
            currentValueSol: 1,
            unclaimedFeeSol: 0,
            hasLiquidity: true
          },
          {
            poolAddress: 'pool-old',
            positionAddress: 'pos-old',
            chainPositionAddress: 'pos-old',
            mint: 'mint-old',
            lowerBinId: 0,
            upperBinId: 68,
            activeBinId: 34,
            solSide: 'tokenX',
            solDepletedBins: 0,
            currentValueSol: 1,
            unclaimedFeeSol: 0,
            hasLiquidity: true
          }
        ],
        fills: [{
          submissionId: 'paper-overlay-open',
          chainPositionAddress: 'paper-chain-position',
          mint: 'mint-paper',
          side: 'add-lp',
          amount: 1,
          actualFilledSol: 1,
          fillAmountSource: 'wallet-delta',
          hasFillEvidence: true,
          recordedAt: oldRecordedAt
        }]
      } as any
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toContain('sol-depleted-bins');
    expect(result.orderIntent).toMatchObject({
      poolAddress: 'pool-paper',
      tokenMint: 'mint-paper',
      chainPositionAddress: 'paper-chain-position',
      fullPositionExit: true
    });
    const orderJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveOrderPath);
    expect(orderJournal[0]).toMatchObject({
      side: 'withdraw-lp',
      poolAddress: 'pool-paper',
      tokenMint: 'mint-paper',
      chainPositionAddress: 'paper-chain-position'
    });
  });

  it('does not combine a stale context target with a lifecycle-bound observed LP', async () => {
    const staleOpenedAt = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
    const freshOpenedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState({
        activeMint: 'mint-observed',
        activePoolAddress: 'pool-observed',
        positionId: 'position-observed',
        chainPositionAddress: 'position-observed',
        entryFillSubmissionId: 'observed-open',
        openedAt: freshOpenedAt
      }),
      positionLedger: {
        version: 1,
        updatedAt: freshOpenedAt,
        records: [{
          positionKey: 'chain-position:position-observed',
          positionId: 'position-observed',
          chainPositionAddress: 'position-observed',
          activeMint: 'mint-observed',
          activePoolAddress: 'pool-observed',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          entrySol: 0.1,
          entrySolSource: 'actual_fill',
          entryFillSubmissionId: 'observed-open',
          openedAt: freshOpenedAt,
          updatedAt: freshOpenedAt
        }]
      },
      // This stale context previously supplied the old pool/mint and a
      // max-hold duration after the observed position had replaced it.
      context: {
        pool: { address: 'pool-stale', liquidityUsd: 10_000 },
        token: { mint: 'mint-stale', inSession: true, hasSolRoute: true, symbol: 'STALE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpCurrentValueSol: 0.1,
          valuationStatus: 'ready',
          valuationSource: 'paper-shadow-dlmm-active-bin-modeled',
          valuationTrust: 'fallback_display',
          valuationCompleteness: 'untrusted'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-observed',
          positionAddress: 'position-observed',
          chainPositionAddress: 'position-observed',
          mint: 'mint-observed',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 120,
          solSide: 'tokenX',
          solDepletedBins: 5,
          currentValueSol: 0.1,
          displayValueSol: 0.1,
          valuationStatus: 'ready',
          valuationSource: 'paper-shadow-dlmm-active-bin-modeled',
          valuationTrust: 'fallback_display',
          valuationCompleteness: 'untrusted',
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: [
          {
            submissionId: 'stale-open',
            mint: 'mint-stale',
            side: 'add-lp',
            amount: 0.1,
            actualFilledSol: 0.1,
            fillAmountSource: 'wallet-delta',
            hasFillEvidence: true,
            recordedAt: staleOpenedAt
          },
          {
            submissionId: 'observed-open',
            positionId: 'position-observed',
            chainPositionAddress: 'position-observed',
            mint: 'mint-observed',
            side: 'add-lp',
            amount: 0.1,
            actualFilledSol: 0.1,
            fillAmountSource: 'wallet-delta',
            hasFillEvidence: true,
            recordedAt: freshOpenedAt
          }
        ]
      }
    });

    expect(result).toMatchObject({
      action: 'hold',
      liveOrderSubmitted: false
    });
    expect(result.context.pool.address).toBe('pool-observed');
    expect(result.context.token.mint).toBe('mint-observed');
    expect(result.orderIntent).toBeUndefined();
  });

  it('does not reuse stale position-state entry for a new chain LP in the same pool and mint', async () => {
    const oldRecordedAt = '2026-06-30T07:58:40.362Z';
    const newRecordedAt = '2026-06-30T14:45:12.942Z';
    const baseFillPath = join(TEST_JOURNAL_DIR, 'new-token-v1-live-fills.jsonl');

    await appendJsonLine(baseFillPath, {
      submissionId: 'old-open',
      openIntentId: 'lp-open-intent:old',
      chainPositionAddress: 'old-chain-position',
      mint: 'mint-same',
      side: 'add-lp',
      amount: 0.109490125,
      filledSol: 0.109490125,
      actualFilledSol: 0.109490125,
      actualWalletDeltaSol: -0.109490125,
      fillAmountSource: 'wallet-delta',
      hasFillEvidence: true,
      positionId: 'old-chain-position',
      recordedAt: oldRecordedAt
    }, {
      rotateDaily: true,
      now: new Date(oldRecordedAt)
    });

    await appendJsonLine(baseFillPath, {
      submissionId: 'new-open',
      openIntentId: 'lp-open-intent:new',
      chainPositionAddress: 'new-chain-position',
      mint: 'mint-same',
      side: 'add-lp',
      amount: 0.077416045,
      filledSol: 0.077416045,
      actualFilledSol: 0.077416045,
      actualWalletDeltaSol: -0.077416045,
      fillAmountSource: 'wallet-delta',
      hasFillEvidence: true,
      positionId: 'new-chain-position',
      recordedAt: newRecordedAt
    }, {
      rotateDaily: true,
      now: new Date(newRecordedAt)
    });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.02,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'withdraw-lp',
        activeMint: 'mint-same',
        activePoolAddress: 'pool-same',
        chainPositionAddress: 'old-chain-position',
        lifecycleState: 'open',
        entrySol: 0.109490125,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'old-open',
        openedAt: oldRecordedAt,
        updatedAt: oldRecordedAt
      },
      context: {
        pool: { address: 'pool-same', liquidityUsd: 10_000, hasSolRoute: true },
        token: { mint: 'mint-same', inSession: true, hasSolRoute: true, symbol: 'SAME' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpNetPnlPct: -29,
          lpCurrentValueSol: 0.077395153,
          lpLiquidityValueSol: 0.019999072,
          lpUnclaimedFeeValueSol: 0,
          lpRecoverableRentSol: 0.057406080,
          valuationStatus: 'ready',
          valuationSource: 'meteora-withdraw-simulation+meteora-dlmm-swap-quote',
          valuationCompleteness: 'complete'
        },
        route: { hasSolRoute: true, expectedOutSol: 0.02, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-same',
          positionAddress: 'new-chain-position',
          mint: 'mint-same',
          lowerBinId: -489,
          upperBinId: -421,
          activeBinId: -421,
          solSide: 'tokenY',
          solDepletedBins: 0,
          binCount: 69,
          currentValueSol: 0.077395153,
          exitQuoteValueSol: 0.077395153,
          liquidityValueSol: 0.019999072,
          unclaimedFeeValueSol: 0,
          recoverableRentSol: 0.057406080,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationSource: 'meteora-withdraw-simulation+meteora-dlmm-swap-quote',
          valuationCompleteness: 'complete'
        }],
        journalLpPositions: [],
        fills: []
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).not.toContain('lp-stop-loss');
    expect(result.context.trader.lpEntryTradingSol).toBeCloseTo(0.020009965, 9);
    expect(result.context.trader.lpNetPnlPct).toBeGreaterThan(-1);
  });

  it('keeps residual LP positions eligible for bin-based exits even when funded bins are zero', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionLedger: {
        version: 1,
        updatedAt: '2026-04-20T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-residual',
          chainPositionAddress: 'pos-residual',
          activeMint: 'mint-residual',
          activePoolAddress: 'pool-residual',
          entryFillSubmissionId: 'managed-open-residual',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          updatedAt: '2026-04-20T00:00:00.000Z'
        }]
      },
      context: {
        pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
        token: { mint: '', inSession: true, hasSolRoute: false, symbol: '', blockReason: 'no-selected-candidate' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
      },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          {
            poolAddress: 'pool-residual',
            positionAddress: 'pos-residual',
            mint: 'mint-residual',
            lowerBinId: 100,
            upperBinId: 168,
            activeBinId: 165,
            fundedBinCount: 0,
            solSide: 'tokenX',
            solDepletedBins: 65,
            currentValueSol: 0.04,
            unclaimedFeeSol: 0.01,
            hasLiquidity: false,
            hasClaimableFees: true,
            positionStatus: 'residual'
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-residual',
            positionAddress: 'pos-residual',
            mint: 'mint-residual',
            lowerBinId: 100,
            upperBinId: 168,
            activeBinId: 165,
            fundedBinCount: 0,
            solSide: 'tokenX',
            solDepletedBins: 65,
            currentValueSol: 0.04,
            unclaimedFeeSol: 0.01,
            hasLiquidity: false,
            hasClaimableFees: true,
            positionStatus: 'residual'
          }
        ],
        fills: []
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toContain('sol-depleted-bins');
    expect(result.orderIntent?.poolAddress).toBe('pool-residual');
  });

  it('does not treat out-of-range alone as an LP exit when SOL is still heavy', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpActiveBinStatus: 'out-of-range',
          lpSolDepletedBins: 0,
          lpSolExposureStatus: 'sol-heavy',
          lpCurrentValueSol: 0.1,
          lpUnclaimedFeeSol: 0
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('hold');
    expect(result.reason).toBe('hold');
    expect(result.audit.reason).toBe('lp-position-maintain');
  });

  it('derives SOL depleted bins from tokenY-sided LP ranges when source omits the count', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionLedger: {
        version: 1,
        updatedAt: '2026-04-20T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-token-y',
          chainPositionAddress: 'pos-token-y',
          activeMint: 'mint-token-y',
          activePoolAddress: 'pool-token-y',
          entryFillSubmissionId: 'managed-open-token-y',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          updatedAt: '2026-04-20T00:00:00.000Z'
        }]
      },
      context: {
        pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
        token: { mint: '', inSession: true, hasSolRoute: false, symbol: '', blockReason: 'no-selected-candidate' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
      },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          {
            poolAddress: 'pool-token-y',
            positionAddress: 'pos-token-y',
            mint: 'mint-token-y',
            lowerBinId: 100,
            upperBinId: 168,
            activeBinId: 103,
            solSide: 'tokenY',
            currentValueSol: 0.04,
            unclaimedFeeSol: 0.01,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-token-y',
            positionAddress: 'pos-token-y',
            mint: 'mint-token-y',
            lowerBinId: 100,
            upperBinId: 168,
            activeBinId: 103,
            solSide: 'tokenY',
            currentValueSol: 0.04,
            unclaimedFeeSol: 0.01,
            hasLiquidity: true
          }
        ],
        fills: []
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toContain('sol-depleted-bins');
    expect(result.context.trader.lpSolExposureStatus).toBe('sol-depleted');
    expect(result.orderIntent?.poolAddress).toBe('pool-token-y');
  });

  it('records valuation-unavailable when LP valuation inputs are missing', async () => {
    const openedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open',
        entrySol: 0.5,
        openedAt,
        updatedAt: openedAt
      } as any,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: {
          hasInventory: true,
          hasLpPosition: true,
          lpCurrentValueSol: undefined,
          lpUnclaimedFeeSol: 0.01,
          lpSolDepletedBins: 0
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            lowerBinId: 100,
            upperBinId: 168,
            activeBinId: 110,
            solSide: 'tokenX',
            solDepletedBins: 0,
            currentValueSol: undefined,
            unclaimedFeeSol: 0.01,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [],
        fills: []
      }
    });

    const incidentJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveIncidentPath);

      expect(result.action).toBe('hold');
      expect(result.reason).toContain('valuation-unavailable');
      expect(incidentJournal).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stage: 'engine',
          severity: 'warning',
          reason: 'valuation-unavailable:missing-current-value'
        })
      ]));
    });

  it('records an incident when an open LP position is missing entry metadata', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-gap',
        activePoolAddress: 'pool-gap',
        lifecycleState: 'open',
        updatedAt: '2026-04-20T00:00:00.000Z'
      } as any,
      context: {
        pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
        token: { mint: '', inSession: true, hasSolRoute: false, symbol: '', blockReason: 'no-selected-candidate' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
      },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          {
            poolAddress: 'pool-gap',
            positionAddress: 'pos-gap',
            mint: 'mint-gap',
            lowerBinId: 100,
            upperBinId: 168,
            activeBinId: 110,
            solSide: 'tokenX',
            solDepletedBins: 0,
            currentValueSol: 0.051,
            unclaimedFeeSol: 0.001,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [],
        fills: []
      }
    });

    const incidentJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveIncidentPath);

    expect(result.action).toBe('hold');
    expect(incidentJournal).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'runtime-policy',
        severity: 'warning',
        reason: 'lp-position-missing-entry-metadata:mint-gap'
      })
    ]));
  });

  it('uses LP risk sentinel range exits before waiting for stop-loss PnL', async () => {
    const openedAt = new Date(Date.now() - (5 * 60 * 60 * 1000)).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-range-risk',
        activePoolAddress: 'pool-range-risk',
        lifecycleState: 'open',
        openedAt,
        updatedAt: '2026-06-30T12:00:00.000Z',
        entrySol: 0.109490125,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open-range-risk'
      } as any,
      context: {
        pool: { address: 'pool-range-risk', liquidityUsd: 40_000 },
        token: { mint: 'mint-range-risk', inSession: true, hasSolRoute: true },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-range-risk',
          positionAddress: 'position-range-risk',
          chainPositionAddress: 'position-range-risk',
          mint: 'mint-range-risk',
          lowerBinId: -234,
          upperBinId: -166,
          activeBinId: -149,
          solSide: 'tokenX',
          solDepletedBins: 0,
          currentValueSol: 0.117723656,
          liquidityValueSol: 0.054595939,
          unclaimedFeeValueSol: 0.005721637,
          claimedFeeValueSol: 0,
          recoverableRentSol: 0.05740608,
          lpTotalValueSol: 0.117723656,
          unclaimedFeeSol: 0.005721637,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationReason: '',
          valuationSource: 'meteora-withdraw-simulation+swap-provider-sell-quote+position-account-rent'
        }],
        journalLpPositions: [],
        fills: [{
          submissionId: 'sub-open-range-risk',
          chainPositionAddress: 'position-range-risk',
          mint: 'mint-range-risk',
          side: 'add-lp',
          amount: 0.109490125,
          actualFilledSol: 0.109490125,
          actualWalletDeltaSol: 0.109490125,
          fillAmountSource: 'wallet-delta',
          hasFillEvidence: true,
          recordedAt: openedAt
        }]
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toContain('lp-range-exit:active-bin-out-of-range:above:17');
    expect(result.context.trader.lpRiskIntent).toBe('range-exit');
    expect(result.context.trader.lpNetPnlPct).toBeGreaterThan(0);
  });

  it('never converts an unrelated wallet token into a residual exit target', async () => {
    const broadcast = vi.fn();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.05,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'withdraw-lp',
        activeMint: 'strategy-mint',
        activePoolAddress: 'strategy-pool',
        lifecycleState: 'inventory_exit_ready',
        updatedAt: '2026-06-29T17:00:00.000Z'
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [{
          mint: 'personal-wallet-mint',
          symbol: 'PERSONAL',
          amount: 100,
          amountRaw: '100000000',
          currentValueSol: 0.2
        }],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      context: {
        pool: { address: 'personal-pool', liquidityUsd: 10_000 },
        token: { mint: 'personal-wallet-mint', inSession: true, hasSolRoute: true, symbol: 'PERSONAL' },
        trader: { hasInventory: true, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.05, slippageBps: 50 }
      },
      broadcaster: { broadcast }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('zero_token_balance_resolved:strategy-mint');
    expect(result.orderIntent).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('never sells same-mint wallet inventory without a strategy-owned raw amount', async () => {
    const broadcast = vi.fn();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.05,
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [{
          mint: 'personal-wallet-mint',
          symbol: 'PERSONAL',
          amount: 100,
          amountRaw: '100000000',
          currentValueSol: 0.2
        }],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      context: {
        pool: { address: 'personal-pool', liquidityUsd: 10_000 },
        token: { mint: 'personal-wallet-mint', inSession: false, hasSolRoute: true, symbol: 'PERSONAL' },
        trader: { hasInventory: true, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.2, slippageBps: 50 }
      },
      broadcaster: { broadcast }
    });

    expect(result).toMatchObject({
      mode: 'BLOCKED',
      action: 'dca-out',
      reason: 'residual-ownership-amount-unknown'
    });
    expect(result.orderIntent).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('selects a legacy positionId-only managed LP while ignoring a manual sibling in the same pool', async () => {
    const openedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const makePosition = (suffix: string) => ({
      poolAddress: `pool-${suffix}`,
      positionAddress: `pos-${suffix}`,
      chainPositionAddress: `pos-${suffix}`,
      mint: `mint-${suffix}`,
      lowerBinId: 100,
      upperBinId: 168,
      activeBinId: 165,
      solDepletedBins: 61,
      currentValueSol: 0.1,
      liquidityValueSol: 0.1,
      unclaimedFeeValueSol: 0,
      claimedFeeValueSol: 0,
      recoverableRentSol: 0,
      lpTotalValueSol: 0.1,
      unclaimedFeeSol: 0,
      hasLiquidity: true,
      valuationStatus: 'ready' as const,
      valuationCompleteness: 'complete' as const,
      valuationTrust: 'exit_quote' as const,
      valuationSource: 'meteora-withdraw-simulation'
    });
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionState: activeLpPositionState({
        activeMint: 'mint-a',
        activePoolAddress: 'pool-a',
        chainPositionAddress: 'pos-a',
        entryFillSubmissionId: 'fill-a',
        openedAt
      }),
      positionLedger: {
        version: 1,
        updatedAt: new Date().toISOString(),
        records: [
          {
            positionKey: 'chain-position:pos-a',
            chainPositionAddress: 'pos-a',
            activeMint: 'mint-a',
            activePoolAddress: 'pool-a',
            lifecycleState: 'open',
            importStatus: 'imported',
            entrySol: 0.1,
            entrySolSource: 'actual_fill',
            entryFillSubmissionId: 'fill-a',
            openedAt,
            lastAction: 'withdraw-lp',
            lastExitAttemptAt: new Date(Date.now() - 10_000).toISOString(),
            exitAttemptCount: 1,
            updatedAt: new Date().toISOString()
          },
          {
            positionKey: 'position:pos-b',
            positionId: 'pos-b',
            activeMint: 'mint-b',
            activePoolAddress: 'pool-b',
            lifecycleState: 'open',
            importStatus: 'imported',
            entrySol: 0.1,
            entrySolSource: 'actual_fill',
            entryFillSubmissionId: 'fill-b',
            openedAt,
            lastAction: 'hold',
            updatedAt: new Date().toISOString()
          }
        ]
      },
      context: {
        pool: { address: 'pool-a', liquidityUsd: 10_000 },
        token: { mint: 'mint-a', inSession: true, hasSolRoute: true, symbol: 'A' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          makePosition('a'),
          {
            ...makePosition('b'),
            positionAddress: 'pos-manual-b',
            chainPositionAddress: 'pos-manual-b',
            activeBinId: 168,
            solDepletedBins: 68
          },
          makePosition('b')
        ],
        journalLpPositions: [],
        fills: [
          {
            submissionId: 'fill-a',
            chainPositionAddress: 'pos-a',
            mint: 'mint-a',
            side: 'add-lp',
            amount: 0.1,
            actualFilledSol: 0.1,
            fillAmountSource: 'wallet-delta',
            hasFillEvidence: true,
            recordedAt: openedAt
          },
          {
            submissionId: 'fill-b',
            chainPositionAddress: 'pos-b',
            mint: 'mint-b',
            side: 'add-lp',
            amount: 0.1,
            actualFilledSol: 0.1,
            fillAmountSource: 'wallet-delta',
            hasFillEvidence: true,
            recordedAt: openedAt
          }
        ]
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.orderIntent).toMatchObject({
      tokenMint: 'mint-b',
      poolAddress: 'pool-b',
      chainPositionAddress: 'pos-b'
    });
  });

  it('does not max-hold or trade an orphan LP without Lightld ownership evidence', async () => {
    const firstSeenOnChainAt = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      positionLedger: {
        version: 1,
        updatedAt: new Date().toISOString(),
        records: [{
          positionKey: 'chain-position:pos-orphan-max-hold',
          chainPositionAddress: 'pos-orphan-max-hold',
          activeMint: 'mint-orphan-max-hold',
          activePoolAddress: 'pool-orphan-max-hold',
          lifecycleState: 'open',
          importStatus: 'entry_unknown',
          firstSeenOnChainAt,
          lastAction: 'hold',
          updatedAt: new Date().toISOString()
        }]
      },
      context: {
        pool: { address: 'pool-orphan-max-hold', liquidityUsd: 10_000 },
        token: { mint: 'mint-orphan-max-hold', inSession: true, hasSolRoute: true },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-orphan-max-hold',
          positionAddress: 'pos-orphan-max-hold',
          chainPositionAddress: 'pos-orphan-max-hold',
          mint: 'mint-orphan-max-hold',
          lowerBinId: 100,
          upperBinId: 168,
          activeBinId: 130,
          solDepletedBins: 0,
          currentValueSol: 0.1,
          liquidityValueSol: 0.1,
          unclaimedFeeValueSol: 0,
          claimedFeeValueSol: 0,
          recoverableRentSol: 0,
          lpTotalValueSol: 0.1,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationTrust: 'exit_quote',
          valuationSource: 'meteora-withdraw-simulation'
        }],
        journalLpPositions: [],
        fills: []
      }
    });

    expect(result.action).toBe('hold');
    expect(result.mode).toBe('BLOCKED');
    expect(result.orderIntent).toBeUndefined();
  });
});
