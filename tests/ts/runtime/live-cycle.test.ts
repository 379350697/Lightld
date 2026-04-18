import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

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
});
