import { describe, expect, it } from 'vitest';

import { DEFAULT_ROUND_TRIP_CHAIN_COST_SOL } from '../../../src/config/economic-defaults.ts';
import { evaluateEntryEconomicEdge } from '../../../src/strategy/entry-edge.ts';

describe('entry economic edge', () => {
  it('stays disabled unless the strategy enables it', () => {
    expect(evaluateEntryEconomicEdge({}, {}).accepted).toBe(true);
  });

  it('requires fee income to exceed costs and safety margin', () => {
    const accepted = evaluateEntryEconomicEdge({ positionSol: 1, expectedFeeSol: 0.02 }, { enabled: true });
    const rejected = evaluateEntryEconomicEdge({ positionSol: 1, expectedFeeSol: 0.001 }, { enabled: true });
    expect(accepted.reason).toBe('entry-edge-positive');
    expect(rejected.reason).toBe('entry-edge-not-positive');
  });

  it('fails closed when an enabled policy has no usable inputs', () => {
    expect(evaluateEntryEconomicEdge({}, { enabled: true }).reason).toBe('entry-edge-missing-position');
    expect(evaluateEntryEconomicEdge({ positionSol: 1 }, { enabled: true }).reason).toBe('entry-edge-missing-fee');
  });

  it('charges a conservative full-lifecycle chain cost by default', () => {
    const result = evaluateEntryEconomicEdge({
      positionSol: 1,
      expectedFeeSol: 1,
      adverseSelectionBps: 0,
      impermanentLossBps: 0,
      roundTripCostBps: 0,
      capitalChargeBps: 0,
      safetyMarginBps: 0
    }, { enabled: true });

    expect(DEFAULT_ROUND_TRIP_CHAIN_COST_SOL).toBeGreaterThanOrEqual(2 * 25_000 / 1_000_000_000);
    expect(result.totalCostSol).toBe(DEFAULT_ROUND_TRIP_CHAIN_COST_SOL);
  });

  it('scales a 24h fee yield to the strategy holding horizon', () => {
    const eightHour = evaluateEntryEconomicEdge({
      positionSol: 1,
      feeTvlRatio24h: 0.03,
      feeHorizonHours: 8
    }, {
      enabled: true,
      defaultAdverseSelectionBps: 0,
      defaultImpermanentLossBps: 0,
      defaultChainCostSol: 0,
      defaultCapitalChargeBps: 0,
      defaultSafetyMarginBps: 0
    });

    expect(eightHour.expectedFeeSol).toBeCloseTo(0.01, 12);
  });

  it('does not reinterpret a valid ratio above one as a percent-number', () => {
    const result = evaluateEntryEconomicEdge({
      positionSol: 1,
      feeTvlRatio24h: 1.5,
      feeHorizonHours: 24
    }, {
      enabled: true,
      defaultAdverseSelectionBps: 0,
      defaultImpermanentLossBps: 0,
      defaultChainCostSol: 0,
      defaultCapitalChargeBps: 0,
      defaultSafetyMarginBps: 0
    });

    expect(result.expectedFeeSol).toBeCloseTo(1.5, 12);
  });
});
