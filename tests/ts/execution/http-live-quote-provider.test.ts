import { describe, expect, it } from 'vitest';

import { HttpLiveQuoteProvider } from '../../../src/execution/http-live-quote-provider';

describe('HttpLiveQuoteProvider', () => {
  it('loads a quote from an external http service', async () => {
    const provider = new HttpLiveQuoteProvider({
      url: 'https://quote.example/api',
      fetchImpl: async (input, init) => {
        expect(input).toBe('https://quote.example/api');
        expect(init?.method).toBe('POST');

        return new Response(
          JSON.stringify({
            routeExists: true,
            outputSol: 0.25,
            slippageBps: 50,
            quotedAt: '2026-03-21T00:00:00.000Z',
            stale: false
          }),
          { status: 200 }
        );
      }
    });

    await expect(
      provider.collect({
        expectedOutSol: 0.25,
        slippageBps: 50,
        routeExists: true
      })
    ).resolves.toEqual({
      routeExists: true,
      outputSol: 0.25,
      slippageBps: 50,
      quotedAt: '2026-03-21T00:00:00.000Z',
      stale: false
    });
  });
});
