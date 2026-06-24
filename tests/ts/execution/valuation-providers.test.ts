import { describe, expect, it, vi } from 'vitest';

import {
  DexScreenerValuationProvider,
  MeteoraDlmmQuoteOnlyValuationProvider,
  ValuationProviderChain
} from '../../../src/execution/solana/valuation-providers';

describe('valuation providers', () => {
  it('uses Meteora quote-only as an exit-quote valuation without building a swap transaction', async () => {
    const quoteTokenToSol = vi.fn(async () => ({
      outAmountLamports: '20000000',
      minOutAmountLamports: '19000000',
      consumedInAmountLamports: '123456',
      provider: 'meteora-dlmm-quote-only' as const
    }));
    const swapTokenToSol = vi.fn();
    const provider = new MeteoraDlmmQuoteOnlyValuationProvider({
      quoteTokenToSol,
      swapTokenToSol
    } as any);

    const result = await provider.quoteTokenToSol({
      inputMint: 'token-mint',
      amountLamports: '123456',
      poolAddress: 'pool-1',
      slippageBps: 100
    });

    expect(result).toMatchObject({
      providerName: 'meteora-dlmm-quote-only',
      valueSol: 0.02,
      trust: 'exit_quote',
      source: 'meteora-dlmm-swap-quote'
    });
    expect(quoteTokenToSol).toHaveBeenCalledWith('pool-1', 'token-mint', '123456', 100);
    expect(swapTokenToSol).not.toHaveBeenCalled();
  });

  it('retries transient Meteora quote-only failures before falling back to market price', async () => {
    const quoteTokenToSol = vi.fn()
      .mockRejectedValueOnce(new Error('No RPC endpoint available for dlmm'))
      .mockResolvedValueOnce({
        outAmountLamports: '20000000',
        minOutAmountLamports: '19000000',
        consumedInAmountLamports: '123456',
        provider: 'meteora-dlmm-quote-only' as const
      });
    const provider = new MeteoraDlmmQuoteOnlyValuationProvider({
      quoteTokenToSol
    } as any, {
      retryDelayMs: 0
    });

    const result = await provider.quoteTokenToSol({
      inputMint: 'token-mint',
      amountLamports: '123456',
      poolAddress: 'pool-1',
      slippageBps: 100
    });

    expect(result).toMatchObject({
      providerName: 'meteora-dlmm-quote-only',
      trust: 'exit_quote',
      valueSol: 0.02
    });
    expect(quoteTokenToSol).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent Meteora quote-only failures', async () => {
    const quoteTokenToSol = vi.fn(async () => {
      throw new Error('Meteora pool pool-1 is not a token/SOL pair');
    });
    const provider = new MeteoraDlmmQuoteOnlyValuationProvider({
      quoteTokenToSol
    } as any, {
      retryDelayMs: 0
    });

    await expect(provider.quoteTokenToSol({
      inputMint: 'token-mint',
      amountLamports: '123456',
      poolAddress: 'pool-1',
      slippageBps: 100
    })).rejects.toThrow('not a token/SOL pair');
    expect(quoteTokenToSol).toHaveBeenCalledTimes(1);
  });

  it('marks DEXScreener pair valuations as market-price only', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      {
        pairAddress: 'pool-1',
        priceNative: '0.000006',
        liquidity: { usd: 10_000 },
        baseToken: { address: 'token-mint' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112' }
      }
    ])));
    const provider = new DexScreenerValuationProvider({
      apiUrl: 'https://dex.example',
      fetchImpl
    });

    const result = await provider.quoteTokenToSol({
      inputMint: 'token-mint',
      amountLamports: '2000000',
      tokenDecimals: 6,
      poolAddress: 'pool-1',
      slippageBps: 100
    });

    expect(result).toMatchObject({
      providerName: 'dexscreener-pair',
      valueSol: 0.000012,
      trust: 'market_price',
      source: 'dexscreener-pair'
    });
  });

  it('continues from a failed exit quote to market-price fallback without upgrading trust', async () => {
    const exitProvider = {
      name: 'meteora-dlmm-quote-only' as const,
      enabled: () => true,
      quoteTokenToSol: vi.fn(async () => {
        throw new Error('quote unavailable');
      })
    };
    const marketProvider = {
      name: 'dexscreener-pair' as const,
      enabled: () => true,
      quoteTokenToSol: vi.fn(async () => ({
        providerName: 'dexscreener-pair' as const,
        valueSol: 0.01,
        trust: 'market_price' as const,
        source: 'dexscreener-pair'
      }))
    };
    const chain = new ValuationProviderChain([exitProvider, marketProvider]);

    const result = await chain.quoteTokenToSol({
      inputMint: 'token-mint',
      amountLamports: '1000000',
      tokenDecimals: 6,
      poolAddress: 'pool-1',
      slippageBps: 100
    });

    expect(result).toMatchObject({
      providerName: 'dexscreener-pair',
      trust: 'market_price',
      providerAttempts: [
        expect.objectContaining({ providerName: 'meteora-dlmm-quote-only', status: 'failed' }),
        expect.objectContaining({ providerName: 'dexscreener-pair', status: 'succeeded' })
      ]
    });
  });

  it('does not negative-cache transient Meteora quote-only failures', async () => {
    const exitProvider = {
      name: 'meteora-dlmm-quote-only' as const,
      enabled: () => true,
      quoteTokenToSol: vi.fn()
        .mockRejectedValueOnce(new Error('No RPC endpoint available for dlmm'))
        .mockResolvedValueOnce({
          providerName: 'meteora-dlmm-quote-only' as const,
          valueSol: 0.02,
          trust: 'exit_quote' as const,
          source: 'meteora-dlmm-swap-quote'
        })
    };
    const marketProvider = {
      name: 'dexscreener-pair' as const,
      enabled: () => true,
      quoteTokenToSol: vi.fn(async () => ({
        providerName: 'dexscreener-pair' as const,
        valueSol: 0.01,
        trust: 'market_price' as const,
        source: 'dexscreener-pair'
      }))
    };
    const chain = new ValuationProviderChain([exitProvider, marketProvider], {
      cooldownMs: 30_000,
      negativeCacheTtlMs: 60_000
    });
    const request = {
      inputMint: 'token-mint',
      amountLamports: '1000000',
      tokenDecimals: 6,
      poolAddress: 'pool-1',
      slippageBps: 100
    };

    const first = await chain.quoteTokenToSol(request);
    const second = await chain.quoteTokenToSol(request);

    expect(first.trust).toBe('market_price');
    expect(second).toMatchObject({
      providerName: 'meteora-dlmm-quote-only',
      trust: 'exit_quote'
    });
    expect(exitProvider.quoteTokenToSol).toHaveBeenCalledTimes(2);
  });
});
