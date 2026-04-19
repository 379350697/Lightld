import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
    expect(fillJournal[0]).toMatchObject({
      strategyId: 'new-token-v1',
      side: 'withdraw-lp',
      status: 'submitted',
      confirmationStatus: 'submitted'
    });
    expect(fillJournal[0]).toHaveProperty('mint');
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

  it('emits evolution outcome evidence with a parameter snapshot for LP exits', async () => {
    const outcomes: LiveCycleOutcomeRecord[] = [];

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
        openedAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z'
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
          lpCurrentValueSol: 0.13,
          lpUnclaimedFeeSol: 0.01
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
      openedAt: '2026-04-18T00:00:00.000Z',
      closedAt: expect.any(String),
      entrySol: 0.1,
      maxObservedDrawdownPct: 0,
      actualExitMetricValue: -25,
      lpStopLossNetPnlPctAtEntry: 20,
      lpTakeProfitNetPnlPctAtEntry: 30,
      solDepletionExitBinsAtEntry: 60,
      minBinStepAtEntry: 100,
      parameterSnapshot: {
        lpStopLossNetPnlPct: 20,
        lpTakeProfitNetPnlPct: 30,
        lpSolDepletionExitBins: 60,
        lpMinBinStep: 100,
        maxHoldHours: 10
      },
      exitMetrics: {
        lpNetPnlPct: -25,
        lpSolDepletedBins: 61
      }
    });
    expect(outcomes[0].maxObservedUpsidePct).toBeCloseTo(40, 6);
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(events.some((event) => event.type === 'order')).toBe(true);
    expect(events.some((event) => event.type === 'fill')).toBe(true);
    expect(events.some((event) => event.type === 'cycle_run')).toBe(true);
  });

  it('derives lpNetPnlPct from live position value and recorded entry cost', async () => {
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
          lpCurrentValueSol: 0.72,
          lpUnclaimedFeeSol: 0.03
        },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('lp-stop-loss');
  });

  it('uses the current LP lifecycle fill instead of the earliest fill on the same mint', async () => {
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

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('lp-take-profit');
    expect(result.orderIntent?.poolAddress).toBe('pool-shared');
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

    expect(result.action).toBe('hold');
    expect(result.reason).toContain('valuation-unavailable');
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
