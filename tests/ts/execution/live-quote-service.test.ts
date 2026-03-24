import { describe, expect, it } from 'vitest';

import { collectLiveQuote } from '../../../src/execution/live-quote-service';

describe('collectLiveQuote', () => {
  it('returns a quote with route existence and SOL output', async () => {
    const quote = await collectLiveQuote({
      expectedOutSol: 2.5,
      slippageBps: 50,
      routeExists: true
    });

    expect(quote.routeExists).toBe(true);
    expect(quote.outputSol).toBe(2.5);
    expect(quote.stale).toBe(false);
  });
});
