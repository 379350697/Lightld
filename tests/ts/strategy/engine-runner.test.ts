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
        liquidityUsd: 10_000,
        score: 80
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000,
        minScore: 70,
        minDeployScore: 70
      }
    });

    expect(result.action).toBe('dca-out');
    expect(result.audit.reason).toBe('decision-generated');
  });

  it('returns deploy for new-token when no inventory and score meets threshold', () => {
    const result = runEngineCycle({
      engine: 'new-token',
      snapshot: {
        inSession: true,
        hasInventory: false,
        hasSolRoute: true,
        liquidityUsd: 15_000,
        score: 85
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000,
        minScore: 70,
        minDeployScore: 70
      }
    });

    expect(result.action).toBe('deploy');
    expect(result.audit.reason).toBe('decision-generated');
  });

  it('returns hold when hard gates reject the snapshot', () => {
    const result = runEngineCycle({
      engine: 'large-pool',
      snapshot: {
        score: 80,
        hasSolRoute: false,
        liquidityUsd: 1_000
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000,
        minScore: 70
      }
    });

    expect(result.action).toBe('hold');
    expect(result.audit.reason).toContain('missing-sol-route');
  });
});

