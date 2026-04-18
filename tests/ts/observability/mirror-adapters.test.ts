import { describe, expect, it } from 'vitest';

import { toRuntimeSnapshotEvent } from '../../../src/observability/mirror-adapters';

describe('toRuntimeSnapshotEvent', () => {
  it('builds a high-priority mirror event from health report data', () => {
    const event = toRuntimeSnapshotEvent({
      mode: 'healthy',
      allowNewOpens: true,
      flattenOnly: false,
      pendingSubmission: false,
      circuitReason: '',
      lastSuccessfulTickAt: '2026-03-22T00:00:00.000Z',
      dependencyHealth: { quoteFailures: 0, reconcileFailures: 0 },
      updatedAt: '2026-03-22T00:00:00.000Z'
    }, {
      walletSol: 1.25,
      walletLpPositions: [
        {
          poolAddress: 'pool-1',
          positionAddress: 'pos-1',
          mint: 'mint-1',
          currentValueSol: 0.8,
          unclaimedFeeSol: 0.05,
          hasLiquidity: true
        }
      ]
    });

    expect(event).toMatchObject({
      type: 'runtime_snapshot',
      priority: 'high',
      payload: {
        walletSol: 1.25,
        lpValueSol: 0.8,
        unclaimedFeeSol: 0.05,
        openPositionCount: 1
      }
    });
    expect(event.payload.netWorthSol).toBeCloseTo(2.1, 10);
  });
});
