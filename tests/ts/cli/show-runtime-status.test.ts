import { describe, expect, it } from 'vitest';

import { formatRuntimeStatus } from '../../../src/cli/show-runtime-status';

describe('formatRuntimeStatus', () => {
  it('renders a readable runtime status summary', () => {
    const output = formatRuntimeStatus({
      mode: 'degraded',
      allowNewOpens: false,
      flattenOnly: true,
      pendingSubmission: true,
      circuitReason: 'quote-degraded',
      lastSuccessfulTickAt: '2026-03-22T00:00:00.000Z',
      dependencyHealth: {
        quoteFailures: 3,
        reconcileFailures: 0
      },
      housekeeping: {
        lastHousekeepingAt: '2026-03-22T00:00:06.000Z',
        journalCleanupDeletedFiles: 2,
        mirrorPruneDeletedRows: 4,
        gmgnSafetyCacheEntries: 9,
        lastCleanupError: ''
      },
      mirror: {
        enabled: true,
        state: 'degraded',
        path: '/tmp/lightld.sqlite',
        queueDepth: 5,
        queueCapacity: 1000,
        droppedEvents: 1,
        droppedLowPriority: 1,
        consecutiveFailures: 1,
        lastFlushAt: '2026-03-22T00:00:04.000Z',
        lastFlushLatencyMs: 12,
        cooldownUntil: '',
        lastError: ''
      },
      updatedAt: '2026-03-22T00:00:05.000Z'
    });

    expect(output).toContain('mode=degraded');
    expect(output).toContain('pendingSubmission=true');
    expect(output).toContain('mirrorState=degraded');
    expect(output).toContain('lastHousekeepingAt=2026-03-22T00:00:06.000Z');
    expect(output).toContain('mirrorPruneDeletedRows=4');
  });
});
