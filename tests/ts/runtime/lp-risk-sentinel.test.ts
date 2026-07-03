import { describe, expect, it } from 'vitest';

import { evaluateLpRiskSentinel } from '../../../src/runtime/lp-risk-sentinel';

describe('evaluateLpRiskSentinel', () => {
  it('flags an LP for exit when active bin has crossed above the position range', () => {
    const result = evaluateLpRiskSentinel({
      observedAt: '2026-06-30T12:00:32.674Z',
      activeBinId: -149,
      lowerBinId: -234,
      upperBinId: -166,
      currentValueSol: 0.114030143,
      liquidityValueSol: 0.056624063
    });

    expect(result.riskIntent).toBe('range-exit');
    expect(result.riskReason).toBe('active-bin-out-of-range:above:17');
    expect(result.outOfRangeSide).toBe('above');
    expect(result.outOfRangeBins).toBe(17);
    expect(result.activeBinDistanceToUpper).toBe(-17);
  });

  it('keeps above-range drift within eight bins as a warning instead of an exit', () => {
    const result = evaluateLpRiskSentinel({
      observedAt: '2026-07-04T01:30:00.000Z',
      activeBinId: -158,
      lowerBinId: -234,
      upperBinId: -166,
      currentValueSol: 0.114030143,
      liquidityValueSol: 0.056624063
    });

    expect(result.riskIntent).toBe('range-warning');
    expect(result.riskReason).toBe('active-bin-out-of-range:above-within-tolerance:8/8');
    expect(result.outOfRangeSide).toBe('above');
    expect(result.outOfRangeBins).toBe(8);
  });

  it('still exits immediately when active bin crosses below the position range', () => {
    const result = evaluateLpRiskSentinel({
      observedAt: '2026-07-04T01:30:00.000Z',
      activeBinId: -235,
      lowerBinId: -234,
      upperBinId: -166,
      currentValueSol: 0.114030143,
      liquidityValueSol: 0.056624063
    });

    expect(result.riskIntent).toBe('range-exit');
    expect(result.riskReason).toBe('active-bin-out-of-range:below:1');
  });

  it('flags short-window liquidity and price drops without requiring route quotes', () => {
    const previous = evaluateLpRiskSentinel({
      observedAt: '2026-06-30T13:18:25.774Z',
      activeBinId: 120,
      lowerBinId: 100,
      upperBinId: 168,
      liquidityValueSol: 0.054595939,
      currentPrice: 0.00022
    });

    const result = evaluateLpRiskSentinel({
      observedAt: '2026-06-30T13:19:35.868Z',
      activeBinId: 121,
      lowerBinId: 100,
      upperBinId: 168,
      liquidityValueSol: 0.023894929,
      currentPrice: 0.00015,
      previous
    });

    expect(result.riskIntent).toBe('liquidity-exit');
    expect(result.riskReason).toBe('liquidity-drop');
  });

  it('flags SOL-side depletion across a 69-bin range as an emergency range exit', () => {
    const result = evaluateLpRiskSentinel({
      observedAt: '2026-06-30T14:20:00.000Z',
      activeBinId: -356,
      lowerBinId: -416,
      upperBinId: -348,
      solDepletedBins: 60,
      binCount: 69,
      solDepletionExitBins: 60
    });

    expect(result.riskIntent).toBe('range-exit');
    expect(result.riskReason).toBe('sol-depleted-bins:60/69:threshold=60');
    expect(result.solDepletedRatio).toBeCloseTo(60 / 69);
  });
});
