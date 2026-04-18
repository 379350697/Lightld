import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadMirrorConfig } from '../../../src/observability/mirror-config';
import { createMirrorRuntime } from '../../../src/observability/mirror-runtime';
import { SqliteMirrorWriter } from '../../../src/observability/sqlite-mirror-writer';

describe('SQLite mirror retention', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('prunes rows older than the retention threshold and keeps recent rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-retention-'));
    directories.push(root);
    const writer = new SqliteMirrorWriter({ path: join(root, 'mirror.sqlite') });

    await writer.open();
    await writer.writeBatch([
      {
        type: 'order',
        priority: 'low',
        payload: {
          idempotencyKey: 'old-order',
          cycleId: 'cycle-old',
          strategyId: 'new-token-v1',
          submissionId: 'sub-old',
          confirmationSignature: '',
          poolAddress: 'pool-1',
          tokenMint: 'mint-1',
          tokenSymbol: 'SAFE',
          action: 'add-lp',
          requestedPositionSol: 0.1,
          quotedOutputSol: 0.1,
          broadcastStatus: 'submitted',
          confirmationStatus: 'submitted',
          finality: 'processed',
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z'
        }
      },
      {
        type: 'order',
        priority: 'low',
        payload: {
          idempotencyKey: 'fresh-order',
          cycleId: 'cycle-fresh',
          strategyId: 'new-token-v1',
          submissionId: 'sub-fresh',
          confirmationSignature: '',
          poolAddress: 'pool-1',
          tokenMint: 'mint-1',
          tokenSymbol: 'SAFE',
          action: 'add-lp',
          requestedPositionSol: 0.1,
          quotedOutputSol: 0.1,
          broadcastStatus: 'submitted',
          confirmationStatus: 'submitted',
          finality: 'processed',
          createdAt: '2026-04-14T00:00:00.000Z',
          updatedAt: '2026-04-14T00:00:00.000Z'
        }
      },
      {
        type: 'incident',
        priority: 'low',
        payload: {
          incidentId: 'incident-old',
          cycleId: 'cycle-old',
          stage: 'submit',
          severity: 'warning',
          reason: 'old',
          runtimeMode: 'healthy',
          submissionId: '',
          tokenMint: '',
          tokenSymbol: '',
          recordedAt: '2026-04-01T00:00:00.000Z'
        }
      },
      {
        type: 'runtime_snapshot',
        priority: 'low',
        payload: {
          snapshotAt: '2026-04-14T00:00:00.000Z',
          runtimeMode: 'healthy',
          allowNewOpens: true,
          flattenOnly: false,
          pendingSubmission: false,
          circuitReason: '',
          quoteFailures: 0,
          reconcileFailures: 0,
          walletSol: 1.4,
          lpValueSol: 0.8,
          unclaimedFeeSol: 0.05,
          netWorthSol: 2.25,
          openPositionCount: 1
        }
      }
    ]);

    const checkpointSpy = vi.spyOn(writer, 'checkpointWal');

    const result = await writer.pruneOldData({
      retentionDays: 7,
      now: new Date('2026-04-14T12:00:00.000Z')
    });

    expect(result.deletedRows).toBe(2);
    expect(result.deletedByTable.orders).toBe(1);
    expect(result.deletedByTable.incidents).toBe(1);
    expect(result.deletedByTable.runtimeSnapshots).toBe(0);
    await expect(writer.countRows('orders')).resolves.toBe(1);
    await expect(writer.countRows('incidents')).resolves.toBe(0);
    await expect(writer.countRows('runtime_snapshots')).resolves.toBe(1);
    expect(checkpointSpy).toHaveBeenCalledWith('TRUNCATE');

    await writer.close();
  });

  it('loads mirror retention config from environment', () => {
    const config = loadMirrorConfig({
      LIVE_DB_MIRROR_ENABLED: 'true',
      LIVE_DB_MIRROR_RETENTION_DAYS: '30',
      LIVE_DB_MIRROR_PRUNE_INTERVAL_MS: '600000'
    });

    expect(config.retentionDays).toBe(30);
    expect(config.pruneIntervalMs).toBe(600_000);
  });

  it('runs mirror pruning on its configured interval without blocking flushes', async () => {
    const pruneOldData = vi.fn().mockResolvedValue({
      deletedRows: 3,
      deletedByTable: {
        cycleRuns: 1,
        orders: 1,
        fills: 0,
        reconciliations: 0,
        incidents: 1,
        runtimeSnapshots: 0
      }
    });

    const runtime = createMirrorRuntime({
      config: {
        enabled: true,
        path: '/tmp/test.sqlite',
        queueCapacity: 10,
        batchSize: 2,
        flushIntervalMs: 10,
        maxRetries: 1,
        cooldownMs: 1000,
        failureThreshold: 2,
        retentionDays: 7,
        pruneIntervalMs: 1000
      },
      writer: {
        open: async () => {},
        close: async () => {},
        writeBatch: async () => {},
        pruneOldData
      }
    });

    runtime.enqueue({
      type: 'incident',
      priority: 'high',
      payload: {
        incidentId: 'i1',
        cycleId: 'c1',
        stage: 'mirror',
        severity: 'warning',
        reason: 'test',
        runtimeMode: 'healthy',
        submissionId: '',
        tokenMint: '',
        tokenSymbol: '',
        recordedAt: '2026-03-22T00:00:00.000Z'
      }
    });

    await runtime.flushOnce({ now: new Date('2026-04-14T00:00:00.000Z') });
    expect(pruneOldData).toHaveBeenCalledTimes(1);

    await runtime.flushOnce({ now: new Date('2026-04-14T00:00:00.500Z') });
    expect(pruneOldData).toHaveBeenCalledTimes(1);

    await runtime.flushOnce({ now: new Date('2026-04-14T00:00:02.000Z') });
    expect(pruneOldData).toHaveBeenCalledTimes(2);
  });
});
