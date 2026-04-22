import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveEvolutionPaths } from '../../../src/evolution';
import { appendJsonLine } from '../../../src/journals/jsonl-writer';
import {
  applyCatchupWindow,
  enqueueMirrorCatchupFromJournals
} from '../../../src/observability/mirror-catchup';
import type { MirrorEvent } from '../../../src/observability/mirror-events';

describe('applyCatchupWindow', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('returns only unseen journal records after the stored cursor', () => {
    const result = applyCatchupWindow({
      lines: [
        { offset: 1, value: { cycleId: 'c1' } },
        { offset: 2, value: { cycleId: 'c2' } }
      ],
      lastOffset: 1
    });

    expect(result.map((entry) => entry.offset)).toEqual([2]);
  });

  it('replays unseen journal rows into low-priority mirror events and advances the cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-catchup-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const events: MirrorEvent[] = [];

    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-orders.jsonl'), {
      cycleId: 'cycle-1',
      strategyId: 'new-token-v1',
      idempotencyKey: 'k1',
      openIntentId: 'intent-1',
      positionId: 'position-1',
      chainPositionAddress: 'chain-pos-1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      requestedPositionSol: 0.1,
      quotedOutputSol: 0.1,
      createdAt: '2026-03-22T00:00:00.000Z'
    }, {
      rotateDaily: true,
      now: new Date()
    });

    await enqueueMirrorCatchupFromJournals({
      strategyId: 'new-token-v1',
      stateRootDir,
      journalRootDir,
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
          path: join(stateRootDir, 'lightld-observability.sqlite'),
          queueDepth: 0,
          queueCapacity: 16,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 0,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: ''
        })
      }
    });

    const cursor = JSON.parse(
      await readFile(join(stateRootDir, 'mirror-cursor.json'), 'utf8')
    ) as {
      offsets: Record<string, number>;
    };

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'order',
      priority: 'low',
      payload: {
        openIntentId: 'intent-1',
        positionId: 'position-1',
        chainPositionAddress: 'chain-pos-1'
      }
    });
    expect(Object.values(cursor.offsets).every((value) => value > 0)).toBe(true);
  });

  it('replays rotated journal history across days instead of only the latest active file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-catchup-rotated-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const events: MirrorEvent[] = [];

    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-orders.jsonl'), {
      cycleId: 'cycle-old',
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-old',
      poolAddress: 'pool-old',
      outputSol: 0.2,
      requestedPositionSol: 0.2,
      quotedOutputSol: 0.2,
      createdAt: '2026-04-17T00:00:00.000Z'
    }, {
      rotateDaily: true,
      now: new Date('2026-04-17T00:00:00.000Z')
    });

    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-orders.jsonl'), {
      cycleId: 'cycle-new',
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-new',
      poolAddress: 'pool-new',
      outputSol: 0.1,
      requestedPositionSol: 0.1,
      quotedOutputSol: 0.1,
      createdAt: '2026-04-18T00:00:00.000Z'
    }, {
      rotateDaily: true,
      now: new Date('2026-04-18T00:00:00.000Z')
    });

    await enqueueMirrorCatchupFromJournals({
      strategyId: 'new-token-v1',
      stateRootDir,
      journalRootDir,
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
          path: join(stateRootDir, 'lightld-observability.sqlite'),
          queueDepth: 0,
          queueCapacity: 16,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 0,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: ''
        })
      }
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => (event as Extract<MirrorEvent, { type: 'order' }>).payload.idempotencyKey)).toEqual([
      'k-old',
      'k-new'
    ]);
  });

  it('replays canonical LP fill identity fields from journal history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-catchup-fills-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const events: MirrorEvent[] = [];

    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-fills.jsonl'), {
      cycleId: 'cycle-fill',
      strategyId: 'new-token-v1',
      submissionId: 'sub-fill',
      confirmationSignature: 'tx-fill',
      openIntentId: 'intent-1',
      positionId: 'position-1',
      chainPositionAddress: 'chain-pos-1',
      mint: 'mint-safe',
      symbol: 'SAFE',
      side: 'add-lp',
      filledSol: 0.1,
      confirmationStatus: 'confirmed',
      recordedAt: '2026-04-18T00:00:00.000Z'
    }, {
      rotateDaily: true,
      now: new Date('2026-04-18T00:00:00.000Z')
    });

    await enqueueMirrorCatchupFromJournals({
      strategyId: 'new-token-v1',
      stateRootDir,
      journalRootDir,
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
          path: join(stateRootDir, 'lightld-observability.sqlite'),
          queueDepth: 0,
          queueCapacity: 16,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 0,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: ''
        })
      }
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'fill',
      priority: 'low'
    });
    expect((events[0] as any).payload.filledSol).toBe(0.1);
    expect((events[0] as any).payload.positionId).toBe('position-1');
    expect((events[0] as any).payload.openIntentId).toBe('intent-1');
    expect((events[0] as any).payload.chainPositionAddress).toBe('chain-pos-1');
  });

  it('skips malformed journal lines without crashing catch-up and advances the cursor past them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-catchup-badline-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const journalPath = join(journalRootDir, 'new-token-v1-live-orders.jsonl');
    const events: MirrorEvent[] = [];

    await mkdir(journalRootDir, { recursive: true });
    await writeFile(journalPath, [
      JSON.stringify({
        cycleId: 'cycle-good-1',
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-good-1',
        poolAddress: 'pool-1',
        createdAt: '2026-04-21T12:07:22.889Z'
      }),
      '{"cycleId":"cycle-bad","strategyId":"new-token-v1","idempotencyKey":"k-bad"',
      JSON.stringify({
        cycleId: 'cycle-good-2',
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-good-2',
        poolAddress: 'pool-2',
        createdAt: '2026-04-21T12:07:55.951Z'
      }),
      ''
    ].join('\n'), 'utf8');

    const processed = await enqueueMirrorCatchupFromJournals({
      strategyId: 'new-token-v1',
      stateRootDir,
      journalRootDir,
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
          path: join(stateRootDir, 'lightld-observability.sqlite'),
          queueDepth: 0,
          queueCapacity: 16,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 0,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: ''
        })
      }
    });

    const cursor = JSON.parse(
      await readFile(join(stateRootDir, 'mirror-cursor.json'), 'utf8')
    ) as {
      offsets: Record<string, number>;
    };

    expect(processed).toBe(2);
    expect(events).toHaveLength(2);
    expect(events.map((event) => (event as Extract<MirrorEvent, { type: 'order' }>).payload.idempotencyKey)).toEqual([
      'k-good-1',
      'k-good-2'
    ]);
    expect(cursor.offsets['new-token-v1-live-orders']).toBe(3);
  });

  it('skips catch-up when the mirror is not healthy or the queue is under pressure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-catchup-skip-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const events: MirrorEvent[] = [];

    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-orders.jsonl'), {
      cycleId: 'cycle-1',
      strategyId: 'new-token-v1',
      idempotencyKey: 'k1'
    }, {
      rotateDaily: true,
      now: new Date()
    });

    const processed = await enqueueMirrorCatchupFromJournals({
      strategyId: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      mirrorRuntime: {
        enqueue(event) {
          events.push(event);
        },
        start: async () => {},
        stop: async () => {},
        flushOnce: async () => true,
        snapshot: () => ({
          enabled: true,
          state: 'open',
          path: join(stateRootDir, 'lightld-observability.sqlite'),
          queueDepth: 900,
          queueCapacity: 1000,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 3,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: 'db locked'
        })
      }
    });

    expect(processed).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('rehydrates evolution candidate scans and watchlist snapshots into mirror events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-catchup-evolution-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const evolutionPaths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));
    const events: MirrorEvent[] = [];

    await appendJsonLine(evolutionPaths.candidateScansPath, {
      scanId: 'scan-1',
      capturedAt: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 3,
      prefilteredCount: 2,
      postLpCount: 2,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-safe',
      selectedPoolAddress: 'pool-safe',
      candidates: [
        {
          sampleId: 'cand-1',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-1',
          tokenMint: 'mint-safe',
          tokenSymbol: 'SAFE',
          poolAddress: 'pool-safe',
          liquidityUsd: 10000,
          holders: 120,
          safetyScore: 80,
          volume24h: 5000,
          feeTvlRatio24h: 0.12,
          binStep: 20,
          hasInventory: false,
          hasLpPosition: false,
          selected: true,
          selectionRank: 1,
          rejectionStage: 'none',
          runtimeMode: 'healthy',
          sessionPhase: 'active'
        }
      ]
    });

    await appendJsonLine(evolutionPaths.watchlistSnapshotsPath, {
      watchId: 'new-token-v1:mint-safe:pool-safe',
      trackedSince: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      poolAddress: 'pool-safe',
      observationAt: '2026-04-18T01:00:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.4,
      liquidityUsd: 12000,
      activeBinId: 123,
      lowerBinId: 100,
      upperBinId: 140,
      binCount: 41,
      fundedBinCount: 20,
      solDepletedBins: 5,
      unclaimedFeeSol: 0.02,
      hasInventory: true,
      hasLpPosition: true,
      sourceReason: 'selected'
    });

    await enqueueMirrorCatchupFromJournals({
      strategyId: 'new-token-v1',
      stateRootDir,
      journalRootDir,
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
          path: join(stateRootDir, 'lightld-observability.sqlite'),
          queueDepth: 0,
          queueCapacity: 16,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 0,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: ''
        })
      }
    });

    const cursor = JSON.parse(
      await readFile(join(stateRootDir, 'mirror-cursor.json'), 'utf8')
    ) as {
      offsets: Record<string, number>;
    };

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['candidate_scan', 'watchlist_snapshot'])
    );
    expect(
      Object.entries(cursor.offsets).some(([key, value]) => key.includes('candidate-scans') && value > 0)
    ).toBe(true);
    expect(
      Object.entries(cursor.offsets).some(([key, value]) => key.includes('watchlist-snapshots') && value > 0)
    ).toBe(true);
  });
});
