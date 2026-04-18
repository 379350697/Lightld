import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
      priority: 'low'
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
});
