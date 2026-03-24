import { describe, expect, it } from 'vitest';

import { buildStatusView } from '../../../src/observability/mirror-query-service';

describe('buildStatusView', () => {
  it('falls back to file-backed state when the mirror is unavailable', async () => {
    const result = await buildStatusView({
      mirrorQuery: async () => {
        throw new Error('mirror unavailable');
      },
      fileState: async () => ({
        mode: 'healthy',
        pendingSubmission: false,
        allowNewOpens: true,
        flattenOnly: false,
        circuitReason: '',
        lastSuccessfulTickAt: '2026-03-22T00:00:00.000Z',
        dependencyHealth: {
          quoteFailures: 0,
          reconcileFailures: 0
        },
        updatedAt: '2026-03-22T00:00:00.000Z'
      })
    });

    expect(result.mode).toBe('healthy');
    expect(result.pendingSubmission).toBe(false);
  });
});
