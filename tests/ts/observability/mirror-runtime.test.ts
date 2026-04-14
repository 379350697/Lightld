import { describe, expect, it } from 'vitest';

import { createMirrorRuntime } from '../../../src/observability/mirror-runtime';

describe('createMirrorRuntime', () => {
  it('opens the mirror circuit after repeated writer failures without throwing to the caller', async () => {
    let writes = 0;
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
        retentionDays: 30,
        pruneIntervalMs: 60_000
      },
      writer: {
        open: async () => {},
        close: async () => {},
        writeBatch: async () => {
          writes += 1;
          throw new Error('db locked');
        }
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
    await runtime.flushOnce();
    await runtime.flushOnce();

    expect(writes).toBeGreaterThan(0);
    expect(runtime.snapshot().state).toBe('open');
  });
});
