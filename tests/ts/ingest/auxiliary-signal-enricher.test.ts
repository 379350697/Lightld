import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuxiliarySignalsConfig } from '../../../src/config/schema.ts';
import {
  clearAuxiliarySignalCacheForTests,
  enrichCandidatesWithAuxiliarySignals
} from '../../../src/ingest/signals/signal-enricher.ts';
import type { AuxiliarySignalProvider } from '../../../src/ingest/signals/types.ts';

describe('enrichCandidatesWithAuxiliarySignals', () => {
  afterEach(() => {
    clearAuxiliarySignalCacheForTests();
    vi.restoreAllMocks();
  });

  it('returns disabled zero-score fields when auxiliary signals are off', async () => {
    const result = await enrichCandidatesWithAuxiliarySignals([
      candidate({ mint: 'mint-a', symbol: 'AAA', address: 'pool-a' })
    ], {
      config: makeConfig({ enabled: false })
    });

    expect(result).toEqual([
      expect.objectContaining({
        mint: 'mint-a',
        address: 'pool-a',
        auxSignalScore: 0,
        auxSignalStatus: 'disabled'
      })
    ]);
  });

  it('aggregates providers concurrently and keeps partial results when one provider fails', async () => {
    const providers: AuxiliarySignalProvider[] = [
      provider('dexscreener', async () => ({
        provider: 'dexscreener',
        status: 'available',
        signalScore: 18,
        dexscreenerBoostAmount: 220,
        dexscreenerHasProfile: true
      })),
      provider('jupiter', async () => {
        throw new Error('429');
      }),
      provider('coingecko', async () => ({
        provider: 'coingecko',
        status: 'available',
        signalScore: 14,
        coingeckoTrendingRank: 2
      }))
    ];

    const result = await enrichCandidatesWithAuxiliarySignals([
      candidate({ mint: 'mint-hot', symbol: 'HOT' })
    ], {
      config: makeConfig({ maxScoreBonus: 25 }),
      providers
    });

    expect(result[0]).toMatchObject({
      mint: 'mint-hot',
      auxSignalScore: 25,
      auxSignalStatus: 'partial',
      dexscreenerBoostAmount: 220,
      dexscreenerHasProfile: true,
      coingeckoTrendingRank: 2
    });
  });

  it('leaves candidates usable when all providers are unavailable', async () => {
    const providers: AuxiliarySignalProvider[] = [
      provider('dexscreener', async () => ({
        provider: 'dexscreener',
        status: 'unavailable',
        signalScore: 0,
        error: '500'
      })),
      provider('jupiter', async () => {
        throw new Error('network');
      })
    ];

    const result = await enrichCandidatesWithAuxiliarySignals([
      candidate({ mint: 'mint-a', symbol: 'AAA', address: 'pool-a' })
    ], {
      config: makeConfig({ providers: ['dexscreener', 'jupiter'] }),
      providers
    });

    expect(result).toEqual([
      expect.objectContaining({
        mint: 'mint-a',
        address: 'pool-a',
        auxSignalScore: 0,
        auxSignalStatus: 'unavailable'
      })
    ]);
  });

  it('times out slow providers without blocking candidate selection', async () => {
    const providers: AuxiliarySignalProvider[] = [
      provider('dexscreener', async () => new Promise<never>(() => undefined))
    ];

    const result = await enrichCandidatesWithAuxiliarySignals([
      candidate({ mint: 'mint-timeout', symbol: 'SLOW' })
    ], {
      config: makeConfig({
        providers: ['dexscreener'],
        timeoutMs: 1
      }),
      providers
    });

    expect(result[0]).toMatchObject({
      mint: 'mint-timeout',
      auxSignalScore: 0,
      auxSignalStatus: 'timeout'
    });
  });

  it('uses the aggregate cache within the configured TTL', async () => {
    const fetchSignal = vi.fn(async () => ({
      provider: 'dexscreener' as const,
      status: 'available' as const,
      signalScore: 7,
      dexscreenerBoostAmount: 10,
      dexscreenerHasProfile: false
    }));
    const providers: AuxiliarySignalProvider[] = [
      { name: 'dexscreener', fetchSignal }
    ];
    const config = makeConfig({
      providers: ['dexscreener'],
      cacheTtlMs: 1_000
    });
    const rows = [candidate({ mint: 'mint-cache', symbol: 'CACHE' })];

    await enrichCandidatesWithAuxiliarySignals(rows, {
      config,
      providers,
      nowMs: 100
    });
    const cached = await enrichCandidatesWithAuxiliarySignals(rows, {
      config,
      providers,
      nowMs: 500
    });

    expect(fetchSignal).toHaveBeenCalledTimes(1);
    expect(cached[0]).toMatchObject({
      auxSignalScore: 7,
      dexscreenerBoostAmount: 10
    });
  });
});

function makeConfig(overrides: Partial<AuxiliarySignalsConfig> = {}): AuxiliarySignalsConfig {
  const providerOptions = {
    dexscreener: { enabled: true, weight: 1 },
    jupiter: { enabled: true, weight: 1 },
    coingecko: { enabled: true, weight: 1 },
    birdeye: { enabled: true, weight: 1 },
    ...(overrides.providerOptions ?? {})
  };

  return {
    enabled: true,
    mode: 'rank-only',
    timeoutMs: 800,
    cacheTtlMs: 300_000,
    maxCandidatesPerCycle: 30,
    failOpen: true,
    maxScoreBonus: 25,
    providers: ['dexscreener', 'jupiter', 'coingecko'],
    ...overrides,
    providerOptions
  };
}

function candidate(overrides: { mint: string; symbol: string; address?: string }) {
  return {
    address: overrides.address ?? `pool-${overrides.mint}`,
    mint: overrides.mint,
    symbol: overrides.symbol
  };
}

function provider(
  name: AuxiliarySignalProvider['name'],
  fetchSignal: AuxiliarySignalProvider['fetchSignal']
): AuxiliarySignalProvider {
  return { name, fetchSignal };
}
