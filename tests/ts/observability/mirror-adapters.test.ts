import { describe, expect, it } from 'vitest';

import { toRuntimeSnapshotEvent } from '../../../src/observability/mirror-adapters';

describe('toRuntimeSnapshotEvent', () => {
  it('builds a high-priority mirror event from health report data', () => {
    expect(toRuntimeSnapshotEvent({
      mode: 'healthy',
      allowNewOpens: true,
      flattenOnly: false,
      pendingSubmission: false,
      circuitReason: '',
      lastSuccessfulTickAt: '2026-03-22T00:00:00.000Z',
      dependencyHealth: { quoteFailures: 0, reconcileFailures: 0 },
      updatedAt: '2026-03-22T00:00:00.000Z'
    })).toMatchObject({
      type: 'runtime_snapshot',
      priority: 'high'
    });
  });
});
