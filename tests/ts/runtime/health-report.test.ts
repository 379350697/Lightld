import { describe, expect, it } from 'vitest';

import { buildHealthReport } from '../../../src/runtime/health-report';

describe('buildHealthReport', () => {
  it('summarizes the current runtime mode and pending submission state', () => {
    const report = buildHealthReport({
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
        lastHousekeepingAt: '2026-03-22T00:00:01.000Z',
        journalCleanupDeletedFiles: 2,
        mirrorPruneDeletedRows: 4,
        gmgnSafetyCacheEntries: 9,
        lastCleanupError: ''
      }
    });

    expect(report.mode).toBe('degraded');
    expect(report.pendingSubmission).toBe(true);
    expect(report.dependencyHealth.quoteFailures).toBe(3);
    expect(report.housekeeping?.mirrorPruneDeletedRows).toBe(4);
  });
});
