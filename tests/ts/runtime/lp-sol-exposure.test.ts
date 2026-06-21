import { describe, expect, it } from 'vitest';

import { computeSolDepletedBins, deriveLpSolExposureStatus } from '../../../src/runtime/lp-sol-exposure';

describe('LP SOL exposure semantics', () => {
  it('computes depleted bins for SOL on tokenX', () => {
    expect(computeSolDepletedBins({
      lowerBinId: 100,
      upperBinId: 168,
      activeBinId: 165,
      solSide: 'tokenX'
    })).toBe(65);
  });

  it('computes depleted bins for SOL on tokenY', () => {
    expect(computeSolDepletedBins({
      lowerBinId: 100,
      upperBinId: 168,
      activeBinId: 103,
      solSide: 'tokenY'
    })).toBe(65);
  });

  it('marks exposure as sol-depleted at the configured early-exit threshold', () => {
    expect(deriveLpSolExposureStatus({
      solDepletedBins: 60,
      binCount: 69,
      solDepletionExitBins: 60
    })).toBe('sol-depleted');
  });

  it('keeps out-of-range SOL-heavy exposure distinct from depletion', () => {
    expect(deriveLpSolExposureStatus({
      solDepletedBins: 0,
      binCount: 69,
      solDepletionExitBins: 60
    })).toBe('sol-heavy');
  });
});
