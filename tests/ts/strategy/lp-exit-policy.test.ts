import { describe, expect, it } from 'vitest';

import { buildLpExitPolicyDecision } from '../../../src/strategy/lp-exit-policy';

describe('buildLpExitPolicyDecision', () => {
  const config = {
    maxHoldHours: 8,
    lpStopLossNetPnlPct: 5,
    lpTakeProfitNetPnlPct: 5,
    lpMinHoldMinutesBeforeTakeProfit: 5
  };

  it('records take-profit and max-hold together when both conditions are true', () => {
    expect(buildLpExitPolicyDecision({
      hasLpPosition: true,
      lpNetPnlPct: 6,
      holdTimeMs: 8 * 60 * 60 * 1000,
      pendingConfirmationStatus: 'confirmed'
    }, config)).toMatchObject({
      action: 'withdraw-lp',
      reason: 'lp-take-profit',
      reasons: ['lp-take-profit', 'max-hold-with-lp-position']
    });
  });

  it('records stop-loss and range exit together when both conditions are true', () => {
    expect(buildLpExitPolicyDecision({
      hasLpPosition: true,
      lpRiskIntent: 'range-exit',
      lpRiskReason: 'active-bin-out-of-range:above:9',
      lpNetPnlPct: -6,
      holdTimeMs: 10 * 60 * 1000,
      pendingConfirmationStatus: 'confirmed'
    }, config)).toMatchObject({
      action: 'withdraw-lp',
      reason: 'lp-stop-loss',
      reasons: ['lp-stop-loss', 'lp-range-exit:active-bin-out-of-range:above:9']
    });
  });

  it('keeps range exit when PnL is inside thresholds', () => {
    const decision = buildLpExitPolicyDecision({
      hasLpPosition: true,
      lpRiskIntent: 'range-exit',
      lpRiskReason: 'active-bin-out-of-range:above:9',
      lpNetPnlPct: -2,
      holdTimeMs: 10 * 60 * 1000,
      pendingConfirmationStatus: 'confirmed'
    }, config);

    expect(decision).toEqual({
      action: 'withdraw-lp',
      reason: 'lp-range-exit:active-bin-out-of-range:above:9',
      reasons: ['lp-range-exit:active-bin-out-of-range:above:9']
    });
  });

  it('keeps max-hold when PnL is inside thresholds and no range risk exists', () => {
    const decision = buildLpExitPolicyDecision({
      hasLpPosition: true,
      lpNetPnlPct: 2,
      holdTimeMs: 8 * 60 * 60 * 1000,
      pendingConfirmationStatus: 'confirmed'
    }, config);

    expect(decision).toEqual({
      action: 'withdraw-lp',
      reason: 'max-hold-with-lp-position',
      reasons: ['max-hold-with-lp-position']
    });
  });

  it('records every exit condition without dropping later checks', () => {
    const decision = buildLpExitPolicyDecision({
      hasLpPosition: true,
      lpRiskIntent: 'range-exit',
      lpRiskReason: 'active-bin-out-of-range:above:9',
      lpNetPnlPct: 7,
      lpSolDepletedBins: 70,
      lpImpermanentLossPct: 12,
      holdTimeMs: 8 * 60 * 60 * 1000,
      pendingConfirmationStatus: 'confirmed'
    }, {
      ...config,
      lpSolDepletionExitBins: 60,
      lpMaxImpermanentLossPct: 10
    });

    expect(decision).toMatchObject({
      action: 'withdraw-lp',
      reason: 'lp-take-profit',
      reasons: [
        'lp-take-profit',
        'lp-range-exit:active-bin-out-of-range:above:9',
        'lp-max-impermanent-loss',
        'lp-sol-nearly-depleted',
        'max-hold-with-lp-position'
      ]
    });
  });
});
