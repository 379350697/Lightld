import { describe, expect, it } from 'vitest';

import {
  computeDynamicPositionSol,
  computePositionRiskMultiplier
} from '../../../src/risk/dynamic-position-sizing';

describe('computePositionRiskMultiplier', () => {
  it('returns 1 for healthy inputs and never scales up risk', () => {
    expect(computePositionRiskMultiplier({
      safetyScore: 92,
      roundtripImpactBps: 80,
      proposalReadinessScore: 0.82
    })).toBe(1);
  });

  it('shrinks risk when safety, execution, and regime quality deteriorate', () => {
    expect(computePositionRiskMultiplier({
      safetyScore: 68,
      roundtripImpactBps: 260,
      proposalReadinessScore: 0.38
    })).toBe(0.231);
  });
});

describe('computeDynamicPositionSol', () => {
  it('preserves the legacy liquidity bracket cap when no risk context is provided', () => {
    expect(computeDynamicPositionSol(55_000, 0.3)).toBe(0.1);
  });

  it('applies a conservative risk multiplier on top of the liquidity cap', () => {
    expect(computeDynamicPositionSol(55_000, 0.3, undefined, {
      safetyScore: 68,
      roundtripImpactBps: 260,
      proposalReadinessScore: 0.38
    })).toBe(0.023);
  });

  it('never increases size above the base bracket cap even for strong inputs', () => {
    expect(computeDynamicPositionSol(120_000, 0.3, undefined, {
      safetyScore: 95,
      roundtripImpactBps: 60,
      proposalReadinessScore: 0.9
    })).toBe(0.15);
  });
});
