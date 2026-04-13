import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendJsonLine } from '../../../src/journals/jsonl-writer';
import type { MirrorEvent } from '../../../src/observability/mirror-events';
import { buildLiveCycleInputFromIngest } from '../../../src/runtime/ingest-context-builder';
import { runLiveDaemon } from '../../../src/runtime/live-daemon';
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
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        whitelist: ['SAFE'],
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
    };

    expect(result.tickCount).toBe(1);
    expect(health.mode).toBe('healthy');
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
          whitelist: ['SAFE'],
          traderWallet: 'wallet-1',
          requestedPositionSol: 0.1,
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
        whitelist: ['SAFE'],
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
        whitelist: ['SAFE'],
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
          whitelist: ['SAFE'],
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

    const ordersRaw = await readFile(join(journalRootDir, 'new-token-v1-live-orders.jsonl'), 'utf8');
    const orders = ordersRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) as Array<{ side: string }>;
    const positionState = await runtimeStateStore.readPositionState();

    expect(seenActions).toEqual(['withdraw-lp', 'sell']);
    expect(orders.map((order) => order.side)).toEqual(['withdraw-lp', 'sell']);
    expect(positionState?.lastAction).toBe('dca-out');
  });
});
