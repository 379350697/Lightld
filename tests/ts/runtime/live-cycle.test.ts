import { rm } from 'node:fs/promises';

import { beforeEach, describe, expect, it } from 'vitest';

import { readJsonLines } from '../../../src/journals/jsonl-writer';
import type { MirrorEvent } from '../../../src/observability/mirror-events';
import { KillSwitch } from '../../../src/runtime/kill-switch';
import { runLiveCycle } from '../../../src/runtime/live-cycle';

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
      whitelist: ['SAFE'],
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
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
      quotedOutputSol: 0.1
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
      status: 'submitted',
      confirmationStatus: 'submitted'
    });
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
      whitelist: ['SAFE'],
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('hold');
    expect(result.quoteCollected).toBe(false);
    expect(result.liveOrderSubmitted).toBe(false);
  });

  it('blocks when the kill switch is engaged', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      killSwitch: new KillSwitch(true),
      requestedPositionSol: 0.1,
      whitelist: ['SAFE'],
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

  it('allows tokens not in whitelist when requireWhitelist is false', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      whitelist: ['CANARY'],
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

  it('blocks when the requested position exceeds the live cap', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.5,
      whitelist: ['SAFE'],
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
        route: { hasSolRoute: true, expectedOutSol: 0.5, slippageBps: 50 }
      }
    });

    const decisionJournal = await readJsonLines<Record<string, unknown>>(
      result.journalPaths.decisionAuditPath
    );
    const incidentJournal = await readJsonLines<Record<string, unknown>>(
      result.journalPaths.liveIncidentPath
    );

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('live-position-cap-exceeded');
    expect(result.liveOrderSubmitted).toBe(false);
    expect(decisionJournal[0]).toMatchObject({
      strategyId: 'new-token-v1',
      stage: 'guards',
      action: 'withdraw-lp',
      reason: 'live-position-cap-exceeded',
      poolAddress: 'pool-1',
      tokenSymbol: 'SAFE',
      requestedPositionSol: 0.5,
      quoteOutputSol: 0.5,
      routeExists: true,
      killSwitchEngaged: false
    });
    expect(incidentJournal[0]).toMatchObject({
      strategyId: 'new-token-v1',
      stage: 'guards',
      reason: 'live-position-cap-exceeded',
      poolAddress: 'pool-1',
      tokenSymbol: 'SAFE',
      requestedPositionSol: 0.5
    });
  });

  it('emits mirror events without blocking the live cycle result', async () => {
    const events: MirrorEvent[] = [];

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: TEST_JOURNAL_DIR,
      stateRootDir: TEST_STATE_DIR,
      requestedPositionSol: 0.1,
      whitelist: ['SAFE'],
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
});
