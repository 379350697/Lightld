import { describe, expect, it } from 'vitest';

import { buildNewTokenDecision } from '../../../src/strategy/engines/new-token-engine';

describe('buildNewTokenDecision', () => {
  it('returns dca-out when the trader is in session and has inventory', () => {
    expect(
      buildNewTokenDecision({
        inSession: true,
        hasInventory: true,
        score: 80
      })
    ).toEqual({
      action: 'dca-out'
    });
  });

  it('returns deploy when in session, no inventory, and score meets threshold', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, score: 75 },
        { minDeployScore: 70 }
      )
    ).toEqual({
      action: 'deploy'
    });
  });

  it('returns hold when in session, no inventory, but score is below threshold', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, score: 50 },
        { minDeployScore: 70 }
      )
    ).toEqual({
      action: 'hold'
    });
  });

  it('returns hold when out of session regardless of score or inventory', () => {
    expect(
      buildNewTokenDecision({
        inSession: false,
        hasInventory: true,
        score: 99
      })
    ).toEqual({
      action: 'hold'
    });
  });

  it('prioritizes dca-out over deploy when has inventory', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: true, score: 99 },
        { minDeployScore: 50 }
      )
    ).toEqual({
      action: 'dca-out'
    });
  });
});

describe('buildNewTokenDecision — LP mode', () => {
  const lpConfig = {
    minDeployScore: 70,
    lpEnabled: true,
    lpStopLossNetPnlPct: 20,
    lpTakeProfitNetPnlPct: 30
  };

  it('returns add-lp when no LP position and score meets threshold', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, score: 75, hasLpPosition: false },
        lpConfig
      )
    ).toEqual({ action: 'add-lp' });
  });

  it('returns hold when no LP position and score below threshold', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, score: 50, hasLpPosition: false },
        lpConfig
      )
    ).toEqual({ action: 'hold' });
  });

  it('returns withdraw-lp on stop-loss (netPnlPct <= -20%)', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, score: 80, hasLpPosition: true, lpNetPnlPct: -20 },
        lpConfig
      )
    ).toEqual({ action: 'withdraw-lp' });
  });

  it('returns withdraw-lp on take-profit (netPnlPct >= +30%)', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, score: 80, hasLpPosition: true, lpNetPnlPct: 30 },
        lpConfig
      )
    ).toEqual({ action: 'withdraw-lp' });
  });

  it('returns hold when LP position PnL within thresholds', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, score: 80, hasLpPosition: true, lpNetPnlPct: 10 },
        lpConfig
      )
    ).toEqual({ action: 'hold' });
  });

  it('returns hold when LP position exists but no PnL data', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, score: 80, hasLpPosition: true },
        lpConfig
      )
    ).toEqual({ action: 'hold' });
  });

  it('returns hold when out of session even in LP mode', () => {
    expect(
      buildNewTokenDecision(
        { inSession: false, hasInventory: false, score: 99, hasLpPosition: false },
        lpConfig
      )
    ).toEqual({ action: 'hold' });
  });
});
