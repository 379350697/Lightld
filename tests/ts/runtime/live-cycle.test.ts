import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveCycleOutcomeRecord } from '../../../src/evolution';
import { appendJsonLine, readJsonLines } from '../../../src/journals/jsonl-writer';
import type { MirrorEvent } from '../../../src/observability/mirror-events';
import { SpendingLimitsStore } from '../../../src/risk/spending-limits';
import { ExecutionRequestError } from '../../../src/execution/error-classification';
import { KillSwitch } from '../../../src/runtime/kill-switch';
import { runLiveCycle } from '../../../src/runtime/live-cycle';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';

const TEST_JOURNAL_DIR = 'tmp/tests/runtime-live-cycle';
const TEST_STATE_DIR = 'tmp/tests/runtime-live-cycle-state';

describe('runLiveCycle', () => {
  beforeEach(async () => {
    await rm(TEST_JOURNAL_DIR, { recursive: true, force: true });
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
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
          confirmationSignature: 'sig-close',
          submissionIds: ['sub-close'],
          confirmationSignatures: ['sig-close'],
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
  it('marks claim-fee intents for residual SOL liquidation', async () => {
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
  });

  it('writes confirmed LP fills with canonical and compatibility amount fields', async () => {
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

    expect(result.action).toBe('add-lp');
    expect(fillJournal[0]).toMatchObject({
      side: 'add-lp',
      status: 'confirmed',
      confirmationStatus: 'confirmed',
      amount: 0.05,
      filledSol: 0.05
    });
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
      fillAmountSource: 'wallet-delta'
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
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationSource: 'meteora-withdraw-simulation+jupiter-sell-quote'
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
        maxHoldHours: 10
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

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('broadcast-outcome-unknown');
    expect(pendingSubmission).toMatchObject({
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      orderAction: 'withdraw-lp'
    });
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
        entrySol: 1
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
          unclaimedFeeSol: 0.5,
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationReason: '',
          valuationSource: 'meteora-withdraw-simulation+jupiter-sell-quote'
        }],
        journalLpPositions: [],
        fills: []
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toContain('lp-take-profit');
    expect(result.context.trader.lpNetPnlPct).toBeCloseTo(31, 10);
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

  it('treats persisted open LP positions as confirmed for take-profit gating even without live fills', async () => {
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
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationSource: 'meteora-withdraw-simulation+jupiter-sell-quote'
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
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationSource: 'meteora-withdraw-simulation+jupiter-sell-quote'
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
          lpUnclaimedFeeSol: 0,
          valuationStatus: 'ready',
          valuationSource: 'meteora-withdraw-simulation+jupiter-sell-quote'
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

  it('prefers an older journal-backed LP exit over a newer bin-depletion exit', async () => {
    const baseFillPath = join(TEST_JOURNAL_DIR, 'new-token-v1-live-fills.jsonl');

    await appendJsonLine(baseFillPath, {
      submissionId: 'old-open',
      mint: 'mint-old',
      side: 'add-lp',
      amount: 1,
      recordedAt: '2026-04-17T01:00:00.000Z'
    }, {
      rotateDaily: true,
      now: new Date('2026-04-17T01:00:00.000Z')
    });

    await appendJsonLine(baseFillPath, {
      submissionId: 'new-open',
      mint: 'mint-new',
      side: 'add-lp',
      amount: 1,
      recordedAt: '2026-04-18T09:30:00.000Z'
    }, {
      rotateDaily: true,
      now: new Date('2026-04-18T09:30:00.000Z')
    });

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
    expect(result.audit.reason).toMatch(/lp-stop-loss|max-hold-with-lp-position/);
    expect(result.orderIntent?.poolAddress).toBe('pool-old');
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
