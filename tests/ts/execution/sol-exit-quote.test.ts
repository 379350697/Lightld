import { describe, expect, it } from 'vitest';

import { quoteSolExit } from '../../../src/execution/sol-exit-quote';

describe('quoteSolExit', () => {
  it('builds a quote object with the requested values', () => {
    const quote = quoteSolExit({
      expectedOutSol: 0.12,
      slippageBps: 45,
      routeExists: true,
      quotedAt: '2026-03-21T00:00:00.000Z',
      stale: false
    });

    expect(quote).toEqual({
      routeExists: true,
      outputSol: 0.12,
      slippageBps: 45,
      quotedAt: '2026-03-21T00:00:00.000Z',
      stale: false
    });
  });
});
