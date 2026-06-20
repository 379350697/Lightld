import { afterEach, describe, expect, it, vi } from 'vitest';

import { birdeyeSignalProvider } from '../../../src/ingest/signals/providers/birdeye.ts';
import {
  clearCoingeckoSignalProviderCacheForTests,
  coingeckoSignalProvider
} from '../../../src/ingest/signals/providers/coingecko.ts';
import { dexscreenerSignalProvider } from '../../../src/ingest/signals/providers/dexscreener.ts';
import {
  clearJupiterSignalProviderCacheForTests,
  jupiterSignalProvider
} from '../../../src/ingest/signals/providers/jupiter.ts';

describe('auxiliary signal providers', () => {
  afterEach(() => {
    clearJupiterSignalProviderCacheForTests();
    clearCoingeckoSignalProviderCacheForTests();
    vi.restoreAllMocks();
  });

  it('maps DEX Screener token pairs into a normalized signal', async () => {
    const fetchImpl = mockJsonFetch([
      {
        boosts: { active: 100 },
        info: {
          socials: [{ type: 'x', url: 'https://example.test/hot' }],
          websites: [{ url: 'https://hot.example' }]
        }
      }
    ]);

    const result = await dexscreenerSignalProvider.fetchSignal(
      { mint: 'mint-hot', symbol: 'HOT' },
      { baseUrl: 'https://dex.test', fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    expect(result).toMatchObject({
      provider: 'dexscreener',
      status: 'available',
      dexscreenerBoostAmount: 100,
      dexscreenerHasProfile: true
    });
    expect(result.signalScore).toBeGreaterThan(5);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://dex.test/token-pairs/v1/solana/mint-hot',
      { headers: undefined }
    );
  });

  it('fails open on DEX Screener rate limits and malformed payloads', async () => {
    const rateLimitedFetch = mockResponseFetch(new Response('{}', {
      status: 429,
      statusText: 'Too Many Requests'
    }));
    const malformedFetch = mockJsonFetch({ pairs: [] });

    await expect(dexscreenerSignalProvider.fetchSignal(
      { mint: 'mint-hot', symbol: 'HOT' },
      { fetchImpl: rateLimitedFetch as unknown as typeof fetch }
    )).resolves.toMatchObject({
      status: 'unavailable',
      signalScore: 0,
      dexscreenerBoostAmount: 0
    });
    await expect(dexscreenerSignalProvider.fetchSignal(
      { mint: 'mint-hot', symbol: 'HOT' },
      { fetchImpl: malformedFetch as unknown as typeof fetch }
    )).resolves.toMatchObject({
      status: 'unavailable',
      signalScore: 0
    });
  });

  it('keeps Jupiter optional when no API key is configured', async () => {
    const fetchImpl = mockJsonFetch([]);

    const result = await jupiterSignalProvider.fetchSignal(
      { mint: 'mint-hot', symbol: 'HOT' },
      { apiKey: '', fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    expect(result).toMatchObject({
      status: 'unavailable',
      signalScore: 0,
      jupiterOrganicScore: 0,
      jupiterTrendingRank: 0,
      error: 'missing-api-key'
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps Jupiter organic and trending rows into a normalized signal', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/tokens/v2/search')) {
        return jsonResponse([
          { id: 'mint-hot', symbol: 'HOT', organicScore: 80 }
        ]);
      }

      return jsonResponse([
        { id: 'mint-hot', symbol: 'HOT' },
        { id: 'mint-other', symbol: 'OTHER' }
      ]);
    });

    const result = await jupiterSignalProvider.fetchSignal(
      { mint: 'mint-hot', symbol: 'HOT' },
      {
        apiKey: 'jup-key',
        baseUrl: 'https://jup.test',
        fetchImpl: fetchImpl as unknown as typeof fetch
      }
    );

    expect(result).toMatchObject({
      provider: 'jupiter',
      status: 'available',
      jupiterOrganicScore: 80,
      jupiterTrendingRank: 1
    });
    expect(result.signalScore).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps CoinGecko trending rows and fails open on network errors', async () => {
    const fetchImpl = mockJsonFetch({
      coins: [
        { item: { symbol: 'HOT', name: 'Hot Token' } }
      ]
    });
    const failingFetch = vi.fn(async () => {
      throw new Error('network-down');
    });

    await expect(coingeckoSignalProvider.fetchSignal(
      { mint: 'mint-hot', symbol: 'HOT' },
      { baseUrl: 'https://cg.test', fetchImpl: fetchImpl as unknown as typeof fetch }
    )).resolves.toMatchObject({
      provider: 'coingecko',
      status: 'available',
      coingeckoTrendingRank: 1
    });
    await expect(coingeckoSignalProvider.fetchSignal(
      { mint: 'mint-hot', symbol: 'HOT' },
      { baseUrl: 'https://cg-fail.test', fetchImpl: failingFetch as unknown as typeof fetch }
    )).resolves.toMatchObject({
      provider: 'coingecko',
      status: 'unavailable',
      signalScore: 0,
      coingeckoTrendingRank: 0
    });
  });

  it('keeps Birdeye optional when no API key is configured', async () => {
    const fetchImpl = mockJsonFetch({ data: { tokens: [] } });

    const result = await birdeyeSignalProvider.fetchSignal(
      { mint: 'mint-hot', symbol: 'HOT' },
      { apiKey: '', fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    expect(result).toMatchObject({
      provider: 'birdeye',
      status: 'unavailable',
      signalScore: 0,
      birdeyeTrendingRank: 0,
      error: 'missing-api-key'
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function mockJsonFetch(payload: unknown) {
  return vi.fn(async () => jsonResponse(payload));
}

function mockResponseFetch(response: Response) {
  return vi.fn(async () => response);
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json'
    }
  });
}
