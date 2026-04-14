import { describe, expect, it } from 'vitest';

import { recordMarketSnapshot } from '../../../src/cli/record-market-snapshot';

describe('recordMarketSnapshot', () => {
  it('builds a normalized context payload', async () => {
    const result = await recordMarketSnapshot({
      pool: { address: 'pool-1' },
      route: { expectedOutSol: 0.1 }
    });

    expect(result.status).toBe('ok');
    expect(result.context.pool).toEqual({ address: 'pool-1' });
    expect(result.context.route).toEqual({ expectedOutSol: 0.1 });
    expect(result.capturedAt).toMatch(/T/);
  });
});
