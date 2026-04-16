import { describe, expect, it } from 'vitest';

import { runEngineCycle } from '../../../src/strategy/engine-runner';

describe('runEngineCycle', () => {
  it('returns dca-out for actionable new-token snapshots', () => {
    const result = runEngineCycle({
      engine: 'new-token',
      snapshot: {
        inSession: true,
        hasInventory: true,
        hasSolRoute: true,
        liquidityUsd: 10_000
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000
      }
    });

    expect(result.action).toBe('dca-out');
    expect(result.audit.reason).toBe('spot-has-inventory-no-pnl');
  });

  it('returns deploy for new-token when no inventory and hard gates pass', () => {
    const result = runEngineCycle({
      engine: 'new-token',
      snapshot: {
        inSession: true,
        hasInventory: false,
        hasSolRoute: true,
        liquidityUsd: 15_000
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000
      }
    });

    expect(result.action).toBe('deploy');
    expect(result.audit.reason).toBe('spot-open-approved');
  });

  it('returns hold when hard gates reject the snapshot', () => {
    const result = runEngineCycle({
      engine: 'large-pool',
      snapshot: {
        hasSolRoute: false,
        liquidityUsd: 1_000
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000
      }
    });

    expect(result.action).toBe('hold');
    expect(result.audit.reason).toContain('missing-sol-route');
  });
});

