import { describe, expect, it } from 'vitest';

import { evaluateLpPnl, type LpPnlConfig } from '../../../src/risk/position-tracker';

const DEFAULT_CONFIG: LpPnlConfig = {
  stopLossNetPnlPct: 20,
  takeProfitNetPnlPct: 30
};

describe('evaluateLpPnl', () => {
  it('returns hold when entrySol is 0', () => {
    const result = evaluateLpPnl(0, 0, 0, DEFAULT_CONFIG);
    expect(result.action).toBe('hold');
    expect(result.reason).toBe('no-entry-value');
    expect(result.unrealizedPct).toBe(0);
  });

  it('returns hold when entrySol is negative', () => {
    const result = evaluateLpPnl(-1, 1, 0, DEFAULT_CONFIG);
    expect(result.action).toBe('hold');
    expect(result.reason).toBe('no-entry-value');
  });

  it('returns hold when net PnL is within thresholds', () => {
    // entry=10, current=9, fees=1.5 → netPnl = (9+1.5-10)/10*100 = 5%
    const result = evaluateLpPnl(10, 9, 1.5, DEFAULT_CONFIG);
    expect(result.action).toBe('hold');
    expect(result.reason).toBe('within-lp-thresholds');
    expect(result.unrealizedPct).toBeCloseTo(5);
  });

  it('triggers stop-loss when fees cannot offset principal loss', () => {
    // entry=10, current=7, fees=0.5 → netPnl = (7+0.5-10)/10*100 = -25%
    const result = evaluateLpPnl(10, 7, 0.5, DEFAULT_CONFIG);
    expect(result.action).toBe('force-sell');
    expect(result.reason).toContain('lp-stop-loss');
    expect(result.unrealizedPct).toBeCloseTo(-25);
  });

  it('triggers stop-loss at exact threshold boundary', () => {
    // entry=10, current=8, fees=0 → netPnl = -20% exactly
    const result = evaluateLpPnl(10, 8, 0, DEFAULT_CONFIG);
    expect(result.action).toBe('force-sell');
    expect(result.reason).toContain('lp-stop-loss');
    expect(result.unrealizedPct).toBeCloseTo(-20);
  });

  it('does not trigger stop-loss just above threshold', () => {
    // entry=10, current=8.01, fees=0 → netPnl = -19.9%
    const result = evaluateLpPnl(10, 8.01, 0, DEFAULT_CONFIG);
    expect(result.action).toBe('hold');
  });

  it('triggers take-profit when fees push PnL above threshold', () => {
    // entry=10, current=9, fees=4 → netPnl = (9+4-10)/10*100 = 30%
    const result = evaluateLpPnl(10, 9, 4, DEFAULT_CONFIG);
    expect(result.action).toBe('force-sell');
    expect(result.reason).toContain('lp-take-profit');
    expect(result.unrealizedPct).toBeCloseTo(30);
  });

  it('triggers take-profit for pure principal gain', () => {
    // entry=10, current=13, fees=0 → netPnl = 30%
    const result = evaluateLpPnl(10, 13, 0, DEFAULT_CONFIG);
    expect(result.action).toBe('force-sell');
    expect(result.reason).toContain('lp-take-profit');
  });

  it('does not trigger take-profit just below threshold', () => {
    // entry=10, current=12.9, fees=0 → netPnl = 29%
    const result = evaluateLpPnl(10, 12.9, 0, DEFAULT_CONFIG);
    expect(result.action).toBe('hold');
  });

  it('fees can offset principal loss keeping position in hold', () => {
    // entry=10, current=6, fees=3 → netPnl = (6+3-10)/10*100 = -10%
    const result = evaluateLpPnl(10, 6, 3, DEFAULT_CONFIG);
    expect(result.action).toBe('hold');
    expect(result.unrealizedPct).toBeCloseTo(-10);
  });

  it('works with custom config thresholds', () => {
    const tightConfig: LpPnlConfig = {
      stopLossNetPnlPct: 5,
      takeProfitNetPnlPct: 10
    };
    // entry=10, current=9, fees=0 → netPnl = -10% → hits -5% stop-loss
    const result = evaluateLpPnl(10, 9, 0, tightConfig);
    expect(result.action).toBe('force-sell');
    expect(result.reason).toContain('lp-stop-loss');
  });

  it('handles deep loss scenario', () => {
    // entry=10, current=1, fees=0.5 → netPnl = -85%
    const result = evaluateLpPnl(10, 1, 0.5, DEFAULT_CONFIG);
    expect(result.action).toBe('force-sell');
    expect(result.reason).toContain('lp-stop-loss');
    expect(result.unrealizedPct).toBeCloseTo(-85);
  });
});
