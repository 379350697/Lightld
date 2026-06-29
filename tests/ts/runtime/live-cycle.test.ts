import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveCycleOutcomeRecord } from '../../../src/evolution';
import { appendJsonLine, readJsonLines } from '../../../src/journals/jsonl-writer';
import type { MirrorEvent } from '../../../src/observability/mirror-events';
import { SpendingLimitsStore } from '../../../src/risk/spending-limits';
import { ExecutionRequestError } from '../../../src/execution/error-classification';
import { KillSwitch } from '../../../src/runtime/kill-switch';
import { liveIncidentDedupeStore } from '../../../src/runtime/incident-dedupe';
import { runLiveCycle, validateLpWithdrawTriggerEligibility } from '../../../src/runtime/live-cycle';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';

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

  it('blocks a partial withdraw-lp batch while preserving pending lifecycle', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
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

  it('returns LIVE for a confirmed full-exit partial batch despite residual sweep failure', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        walletLpPositions: []
      },
      accountProvider: {
        readState: vi.fn(async () => ({
          walletSol: 1.035,
          journalSol: 1.035,
          walletTokens: [],
          walletLpPositions: []
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

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.liveOrderSubmitted).toBe(true);
    expect(result.reason).toContain('pending-submission-partial-failure');
  });

  it('does not block a confirmed withdraw-lp when residual cleanup is incomplete', async () => {
    const events: MirrorEvent[] = [];
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        walletLpPositions: []
      },
      accountProvider: {
        readState: vi.fn(async () => ({
          walletSol: 1.035,
          journalSol: 1.035,
          walletTokens: [],
          walletLpPositions: []
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
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
  it('emits evolution outcome evidence with a parameter snapshot for LP exits', async () => {
    const outcomes: LiveCycleOutcomeRecord[] = [];
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
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt,
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
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      strategyId: 'new-token-v1',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      positionId: 'pool-1:mint-safe',
      action: 'withdraw-lp',
      actualExitReason: 'lp-stop-loss',
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
        lpNetPnlPct: expect.any(Number),
        lpSolDepletedBins: 61
      }
    });
    expect(outcomes[0].actualExitMetricValue).toBeCloseTo(-25, 10);
    expect(outcomes[0].exitMetrics.lpNetPnlPct).toBeCloseTo(-25, 10);
    expect(outcomes[0].maxObservedUpsidePct).toBe(0);
  });

  it('swallows evolution outcome sink failures without changing the live-cycle result', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
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
        activeMint: 'lp-mint',
        activePoolAddress: 'lp-pool',
        positionId: 'lp-position',
        chainPositionAddress: 'lp-chain-position',
        lifecycleState: 'inventory_exit_ready',
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
      tokenMint: 'residual-mint'
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
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

  it('classifies missing LP position exits as already closed without pending submission', async () => {
    const stateDir = `${TEST_STATE_DIR}-position-already-closed`;

    await rm(stateDir, { recursive: true, force: true });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
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
          mint: 'mint-stale-entry',
          side: 'add-lp',
          amount: 0.077416045,
          actualFilledSol: 0.077416045,
          actualWalletDeltaSol: -0.077416045,
          fillAmountSource: 'wallet-delta',
          hasFillEvidence: true,
          positionId: 'pool-stale-entry:mint-stale-entry',
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
      expect(result.audit.reason).toBe('lp-sol-nearly-depleted');
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

  it('keeps residual LP positions eligible for bin-based exits even when funded bins are zero', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
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
    expect(result.audit.reason).toContain('lp-sol-nearly-depleted');
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
    expect(result.audit.reason).toContain('lp-sol-nearly-depleted');
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
});
