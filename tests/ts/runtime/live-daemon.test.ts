import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendJsonLine, resolveActiveJsonlPath } from '../../../src/journals/jsonl-writer';
import type { MirrorEvent } from '../../../src/observability/mirror-events';
import { createHousekeepingRunner } from '../../../src/runtime/housekeeping';
import { buildLiveCycleInputFromIngest } from '../../../src/runtime/ingest-context-builder';
import { runLiveDaemon } from '../../../src/runtime/live-daemon';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';
import { RuntimeStateStore } from '../../../src/runtime/runtime-state-store';

describe('runLiveDaemon', () => {
  it('writes a health snapshot after running a single tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');

    const result = await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      housekeepingRunner: createHousekeepingRunner({
        intervalMs: 1,
        runJournalCleanup: async () => 2,
        runMirrorPrune: async () => 3,
        runGmgnCacheSweep: () => ({
          expiredDeleted: 0,
          evictedDeleted: 0,
          remainingEntries: 4
        })
      }),
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const health = JSON.parse(await readFile(join(stateRootDir, 'health.json'), 'utf8')) as {
      mode: string;
      housekeeping?: {
        journalCleanupDeletedFiles: number;
        mirrorPruneDeletedRows: number;
      };
    };

    expect(result.tickCount).toBe(1);
    expect(health.mode).toBe('healthy');
    expect(health.housekeeping?.journalCleanupDeletedFiles).toBe(2);
    expect(health.housekeeping?.mirrorPruneDeletedRows).toBe(3);
  });

  it('can drive a tick from ingest-backed context building', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-ingest-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');

    const result = await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () =>
        buildLiveCycleInputFromIngest({
          strategy: 'new-token-v1',
          traderWallet: 'wallet-1',
          requestedPositionSol: 0.1,
          safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
          accountState: {
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [
              { mint: 'mint-safe', symbol: 'SAFE', amount: 1 }
            ],
            journalTokens: [
              { mint: 'mint-safe', symbol: 'SAFE', amount: 1 }
            ],
            fills: []
          },
          now: new Date('2026-03-22T10:00:00'),
          fetchMeteoraPoolsImpl: async () => [
            {
              address: 'pool-safe',
              baseMint: 'mint-safe',
              quoteMint: 'So11111111111111111111111111111111111111112',
              baseSymbol: 'SAFE',
              liquidityUsd: 10_000,
              volume_5m: 5_000,
              updatedAt: '2026-03-22T09:59:00.000Z'
            }
          ],
          fetchPumpTradesImpl: async () => [
            {
              mint: 'mint-safe',
              symbol: 'SAFE',
              holders: 40,
              timestamp: '2026-03-22T09:58:00.000Z'
            },
            {
              wallet: 'wallet-1',
              mint: 'mint-safe',
              side: 'buy',
              amount: 1,
              timestamp: '2026-03-22T09:59:30.000Z'
            }
          ]
        })
    });

    const health = JSON.parse(await readFile(join(stateRootDir, 'health.json'), 'utf8')) as {
      mode: string;
      pendingSubmission: boolean;
    };

    expect(result.tickCount).toBe(1);
    expect(health.mode).toBe('healthy');
    expect(health.pendingSubmission).toBe(true);
  });

  it('keeps the daemon ticking when the mirror runtime degrades', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-mirror-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    let flushes = 0;

    const result = await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      mirrorRuntime: {
        enqueue() {},
        start: async () => {},
        stop: async () => {},
        flushOnce: async () => {
          flushes += 1;
          return false;
        },
        snapshot: () => ({
          enabled: true,
          state: 'open',
          path: join(root, 'mirror.sqlite'),
          queueDepth: 3,
          queueCapacity: 1000,
          droppedEvents: 1,
          droppedLowPriority: 1,
          consecutiveFailures: 3,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '2026-03-22T00:10:00.000Z',
          lastError: 'db locked'
        })
      },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const health = JSON.parse(await readFile(join(stateRootDir, 'health.json'), 'utf8')) as {
      mode: string;
      mirror?: {
        state: string;
      };
    };

    expect(result.tickCount).toBe(1);
    expect(flushes).toBe(1);
    expect(health.mode).toBe('healthy');
    expect(health.mirror?.state).toBe('open');
  });

  it('persists submitted open actions as open_pending until inventory or confirmation evidence exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-open-pending-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          fills: []
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE', score: 90 },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();

    expect(positionState).toMatchObject({
      lastAction: 'add-lp',
      lastReason: 'live-order-submitted',
      activeMint: 'mint-safe',
      lifecycleState: 'open_pending'
    });
  });

  it('runs mirror catch-up during a healthy tick and advances the journal cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-catchup-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const events: MirrorEvent[] = [];

    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-orders.jsonl'), {
      cycleId: 'cycle-preexisting',
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-preexisting',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      requestedPositionSol: 0.1,
      quotedOutputSol: 0.1,
      createdAt: '2026-03-22T00:00:00.000Z'
    }, {
      rotateDaily: true,
      now: new Date()
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      mirrorRuntime: {
        enqueue(event) {
          events.push(event);
        },
        start: async () => {},
        stop: async () => {},
        flushOnce: async () => true,
        snapshot: () => ({
          enabled: true,
          state: 'healthy',
          path: join(root, 'mirror.sqlite'),
          queueDepth: 0,
          queueCapacity: 64,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 0,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: ''
        })
      },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const cursor = JSON.parse(
      await readFile(join(stateRootDir, 'mirror-cursor.json'), 'utf8')
    ) as {
      offsets: Record<string, number>;
    };

    expect(events.some((event) => event.type === 'order' && event.priority === 'low')).toBe(true);
    expect(Object.values(cursor.offsets)).toContain(1);
  });

  it('proves the staged exit chain withdraw-lp -> inventory -> dca-out across ticks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-exit-chain-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    const accountStates = [
      {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 1200 }],
        journalTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 1200 }],
        fills: [{
          submissionId: 'sub-1',
          confirmationSignature: 'tx-1',
          mint: 'mint-safe',
          symbol: 'SAFE',
          side: 'buy' as const,
          amount: 1200,
          recordedAt: '2026-03-22T00:00:02.000Z'
        }]
      }
    ];

    let tick = 0;
    const seenActions: string[] = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 2,
      buildCycleInput: async () => {
        const current = tick;
        tick += 1;
        const accountState = accountStates[Math.min(current, accountStates.length - 1)];

        return {
          requestedPositionSol: 0.1,
          accountState,
          context: {
            pool: { address: 'pool-1', liquidityUsd: 10_000 },
            token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
            trader: current === 0
              ? { hasInventory: false, hasLpPosition: true, lpNetPnlPct: -25 }
              : { hasInventory: true, hasLpPosition: false },
            route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
          },
          signer: {
            sign: async (intent) => ({
              intent,
              signerId: 'test-signer',
              signedAt: '2026-03-22T00:00:01.000Z',
              signature: 'sig'
            })
          },
          broadcaster: {
            broadcast: async (signedIntent) => {
              seenActions.push(signedIntent.intent.side ?? 'unknown');
              return {
                status: 'submitted' as const,
                submissionId: `sub-${current + 1}`,
                idempotencyKey: signedIntent.intent.idempotencyKey,
                confirmationSignature: `tx-${current + 1}`
              };
            }
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
        };
      }
    });

    const ordersRaw = await readFile(
      resolveActiveJsonlPath(join(journalRootDir, 'new-token-v1-live-orders.jsonl')),
      'utf8'
    );
    const orders = ordersRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) as Array<{ side: string }>;
    const positionState = await runtimeStateStore.readPositionState();

    expect(seenActions).toEqual(['withdraw-lp', 'sell']);
    expect(orders.map((order) => order.side)).toEqual(['withdraw-lp', 'sell']);
    expect(positionState?.lastAction).toBe('dca-out');
  });

  it('blocks same-mint reopen after a failed Meteora open recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-open-failed-cooldown-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const pendingSubmissionStore = new PendingSubmissionStore(stateRootDir);
    let broadcasts = 0;

    await pendingSubmissionStore.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-open-failed',
      submissionId: 'sub-open-failed',
      confirmationSignature: 'tx-open-failed',
      confirmationStatus: 'submitted',
      finality: 'processed',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      orderAction: 'add-lp'
    });
    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'live-order-submitted',
      activeMint: 'mint-safe',
      lifecycleState: 'open_pending',
      updatedAt: '2026-03-22T00:00:00.000Z'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 2,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [],
          journalLpPositions: [],
          fills: []
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE', score: 90 },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        },
        confirmationProvider: {
          poll: async ({ submissionId, confirmationSignature }) => ({
            submissionId,
            confirmationSignature,
            status: 'failed' as const,
            finality: 'failed' as const,
            checkedAt: '2026-03-22T00:00:05.000Z'
          })
        },
        signer: {
          sign: async (intent) => ({
            intent,
            signerId: 'test-signer',
            signedAt: '2026-03-22T00:00:01.000Z',
            signature: 'sig'
          })
        },
        broadcaster: {
          broadcast: async () => {
            broadcasts += 1;
            return {
              status: 'submitted' as const,
              submissionId: `sub-${broadcasts}`,
              idempotencyKey: `k-${broadcasts}`,
              confirmationSignature: `tx-${broadcasts}`
            };
          }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();

    expect(broadcasts).toBe(0);
    expect(positionState).toMatchObject({
      activeMint: 'mint-safe',
      lastAction: 'hold',
      lastReason: 'recently-closed-mint:mint-safe',
      lastClosedMint: 'mint-safe',
      lifecycleState: 'closed'
    });
  });
});
