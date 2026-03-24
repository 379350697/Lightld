import { describe, expect, it } from 'vitest';

import { buildDecisionContext } from '../../../src/runtime/build-decision-context';

describe('buildDecisionContext', () => {
  it('normalizes missing sections to empty objects', () => {
    const context = buildDecisionContext({});

    expect(context.pool).toEqual({});
    expect(context.token).toEqual({});
    expect(context.trader).toEqual({});
    expect(context.route).toEqual({});
    expect(context.createdAt).toMatch(/T/);
  });

  it('preserves provided sections', () => {
    const context = buildDecisionContext({
      pool: { address: 'pool-1' },
      route: { expectedOutSol: 0.25 }
    });

    expect(context.pool).toEqual({ address: 'pool-1' });
    expect(context.route).toEqual({ expectedOutSol: 0.25 });
  });
});
