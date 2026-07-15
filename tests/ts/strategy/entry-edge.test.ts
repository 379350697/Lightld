import { describe, expect, it } from 'vitest';

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
});
