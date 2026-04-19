import { describe, expect, it } from 'vitest';

import { buildNewTokenDecision } from '../../../src/strategy/engines/new-token-engine';

describe('buildNewTokenDecision', () => {
  it('returns dca-out when the trader is in session and has inventory', () => {
    expect(
      buildNewTokenDecision({
        inSession: true,
        hasInventory: true
      })
    ).toMatchObject({
      action: 'dca-out'
    });
  });

  it('returns deploy when in session and no inventory', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false },
        {}
      )
    ).toMatchObject({
      action: 'deploy'
    });
  });

  it('returns hold when out of session regardless of inventory state', () => {
    expect(
      buildNewTokenDecision({
        inSession: false,
        hasInventory: true
      })
    ).toMatchObject({
      action: 'hold'
    });
  });

  it('prioritizes dca-out over deploy when has inventory', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: true },
        {}
      )
    ).toMatchObject({
      action: 'dca-out'
    });
  });
});

describe('buildNewTokenDecision — LP mode', () => {
  const lpConfig = {
    lpEnabled: true,
    lpStopLossNetPnlPct: 20,
    lpTakeProfitNetPnlPct: 30
  };

  it('returns add-lp when no LP position and LP mode is enabled', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, hasLpPosition: false },
        lpConfig
      )
    ).toMatchObject({ action: 'add-lp' });
  });

  it('returns withdraw-lp on stop-loss (netPnlPct <= -20%)', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, hasLpPosition: true, lpNetPnlPct: -20 },
        lpConfig
      )
    ).toMatchObject({ action: 'withdraw-lp' });
  });

  it('returns withdraw-lp on take-profit (netPnlPct >= +30%)', () => {
    expect(
      buildNewTokenDecision(
        {
          inSession: true,
          hasInventory: false,
          hasLpPosition: true,
          lpNetPnlPct: 30,
          holdTimeMs: 5 * 60 * 1000,
          pendingConfirmationStatus: 'confirmed'
        },
        lpConfig
      )
    ).toMatchObject({ action: 'withdraw-lp' });
  });

  it('returns hold when LP valuation is unavailable even if stale net PnL looks actionable', () => {
    expect(
      buildNewTokenDecision(
        {
          inSession: true,
          hasInventory: false,
          hasLpPosition: true,
          lpNetPnlPct: -35,
          valuationStatus: 'unavailable',
          valuationReason: 'missing-current-value',
          holdTimeMs: 10 * 60 * 1000,
          pendingConfirmationStatus: 'confirmed'
        },
        lpConfig
      )
    ).toMatchObject({ action: 'hold' });
  });

  it('returns hold when LP position PnL within thresholds', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, hasLpPosition: true, lpNetPnlPct: 10 },
        lpConfig
      )
    ).toMatchObject({ action: 'hold' });
  });

  it('returns hold when LP position exists but no PnL data', () => {
    expect(
      buildNewTokenDecision(
        { inSession: true, hasInventory: false, hasLpPosition: true },
        lpConfig
      )
    ).toMatchObject({ action: 'hold' });
  });

  it('returns withdraw-lp when SOL has been depleted across 67 bins', () => {
    expect(
      buildNewTokenDecision(
        {
          inSession: true,
          hasInventory: false,
          hasLpPosition: true,
          lpSolDepletedBins: 67
        },
        { ...lpConfig, lpSolDepletionExitBins: 67 }
      )
    ).toMatchObject({ action: 'withdraw-lp', reason: 'lp-sol-nearly-depleted' });
  });

  it('returns hold when out of session even in LP mode', () => {
    expect(
      buildNewTokenDecision(
        { inSession: false, hasInventory: false, hasLpPosition: false },
        lpConfig
      )
    ).toMatchObject({ action: 'hold' });
  });

  it('returns claim-fee when unclaimed fees exceed configured threshold', () => {
    expect(
      buildNewTokenDecision(
        {
          inSession: true,
          hasInventory: false,
          hasLpPosition: true,
          lpNetPnlPct: 10,
          lpUnclaimedFeeUsd: 30
        },
        { ...lpConfig, lpClaimFeeThresholdUsd: 25 }
      )
    ).toMatchObject({ action: 'claim-fee' });
  });

  it('returns rebalance-lp when configured and position is out of range', () => {
    expect(
      buildNewTokenDecision(
        {
          inSession: true,
          hasInventory: false,
          hasLpPosition: true,
          lpNetPnlPct: 10,
          lpActiveBinStatus: 'out-of-range'
        },
        { ...lpConfig, lpRebalanceOnOutOfRange: true }
      )
    ).toMatchObject({ action: 'rebalance-lp' });
  });
});
