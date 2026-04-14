import { describe, expect, it } from 'vitest';

import { evaluateHardGates } from '../../../src/strategy/filtering/hard-gates';

describe('evaluateHardGates', () => {
  it('accepts snapshots that satisfy route and liquidity requirements', () => {
    expect(
      evaluateHardGates(
        {
          hasSolRoute: true,
          liquidityUsd: 10_000
        },
        {
          requireSolRoute: true,
          minLiquidityUsd: 5_000
        }
      )
    ).toEqual({
      accepted: true,
      reasons: []
    });
  });

  it('reports both route and liquidity failures', () => {
    expect(
      evaluateHardGates(
        {
          hasSolRoute: false,
          liquidityUsd: 1_000
        },
        {
          requireSolRoute: true,
          minLiquidityUsd: 5_000
        }
      )
    ).toEqual({
      accepted: false,
      reasons: ['missing-sol-route', 'insufficient-liquidity']
    });
  });
});
