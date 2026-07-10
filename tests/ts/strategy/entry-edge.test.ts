import { describe, expect, it } from 'vitest';

import { evaluateEntryEconomicEdge } from '../../../src/strategy/entry-edge';

describe('evaluateEntryEconomicEdge', () => {
  it('requires expected fee to exceed adverse selection, IL, round-trip, chain, capital, and margin costs', () => {
    const accepted = evaluateEntryEconomicEdge({
      requestedPositionSol: 0.1,
      feeTvlRatio24h: 0.12,
      roundtripImpactBps: 80,
      adverseSelectionBps: 20,
      impermanentLossBps: 20,
      chainCostSol: 0.00001,
      capitalChargeBps: 5,
      safetyMarginBps: 10
    }, {
      requirePositiveExpectedEdge: true
    });

    expect(accepted.accepted).toBe(true);
    expect(accepted.reason).toBe('entry-edge-positive');
    expect(accepted.netEdgeSol).toBeGreaterThan(accepted.requiredEdgeSol);

    const rejected = evaluateEntryEconomicEdge({
      requestedPositionSol: 0.1,
      expectedFeeSol: 0.0001,
      roundtripImpactBps: 80,
      adverseSelectionBps: 20,
      impermanentLossBps: 20,
      chainCostSol: 0.00001,
      capitalChargeBps: 5,
      safetyMarginBps: 10
    }, {
      requirePositiveExpectedEdge: true
    });

    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe('entry-edge-not-positive');
  });

  it('fails closed when required edge inputs are missing', () => {
    expect(evaluateEntryEconomicEdge({}, {
      requirePositiveExpectedEdge: true
    })).toMatchObject({
      accepted: false,
      reason: 'entry-edge-missing-position-size'
    });

    expect(evaluateEntryEconomicEdge({
      requestedPositionSol: 0.1
    }, {
      requirePositiveExpectedEdge: true
    })).toMatchObject({
      accepted: false,
      reason: 'entry-edge-missing-expected-fee'
    });
  });
});
