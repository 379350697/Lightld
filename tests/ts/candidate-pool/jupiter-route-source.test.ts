import { describe, expect, it, vi } from 'vitest';

import { createJupiterRouteSource } from '../../../src/candidate-pool/jupiter-route-source';
import { JupiterClient, SOL_MINT } from '../../../src/execution/solana/jupiter-client';
import type { IngestCandidate } from '../../../src/runtime/ingest-candidate-selection';

function makeCandidate(): IngestCandidate {
  return {
    address: 'pool-1',
    mint: 'mint-1',
    symbol: 'SAFE',
    quoteMint: SOL_MINT,
    liquidityUsd: 25_000,
    hasSolRoute: true,
    capturedAt: '2026-06-21T10:00:00.000Z',
    holders: 0,
    hasInventory: false,
    hasLpPosition: false,
    binStep: 120,
    baseFeePct: 1,
    volume24h: 2_000_000,
    feeTvlRatio24h: 0.12,
    auxSignalScore: 0,
    dexscreenerBoostAmount: 0,
    dexscreenerHasProfile: false,
    jupiterOrganicScore: 0,
    jupiterTrendingRank: 0,
    coingeckoTrendingRank: 0,
    auxSignalStatus: 'disabled'
  };
}

function makeClient(overrides: Partial<JupiterClient>): JupiterClient {
  return overrides as unknown as JupiterClient;
}

describe('createJupiterRouteSource', () => {
  it('passes when Jupiter returns a positive route plan', async () => {
    const getQuote = vi.fn(async () => ({
      inputMint: SOL_MINT,
      outputMint: 'mint-1',
      inAmount: '10000000',
      outAmount: '42',
      otherAmountThreshold: '40',
      swapMode: 'ExactIn',
      slippageBps: 100,
      priceImpactPct: '0',
      routePlan: [{}]
    }));
    const source = createJupiterRouteSource({
      client: makeClient({
        getQuote,
        buildBuyQuoteParams: vi.fn(() => ({
          inputMint: SOL_MINT,
          outputMint: 'mint-1',
          amount: '10000000',
          slippageBps: 100,
          swapMode: 'ExactIn' as const
        }))
      }),
      quoteSol: 0.01,
      slippageBps: 100,
      ttlMs: 45_000
    });

    await expect(source.observe(makeCandidate(), {
      strategyId: 'new-token-v1',
      now: new Date('2026-06-21T10:00:00.000Z')
    })).resolves.toMatchObject({
      source: 'jupiter_route',
      status: 'passed',
      hardRejectReason: '',
      rawJson: {
        routePlanLength: 1
      }
    });
    expect(getQuote).toHaveBeenCalledTimes(1);
  });

  it('blocks when Jupiter returns no usable route', async () => {
    const source = createJupiterRouteSource({
      client: makeClient({
        getQuote: vi.fn(async () => ({
          inputMint: SOL_MINT,
          outputMint: 'mint-1',
          inAmount: '10000000',
          outAmount: '0',
          otherAmountThreshold: '0',
          swapMode: 'ExactIn',
          slippageBps: 100,
          priceImpactPct: '0',
          routePlan: []
        })),
        buildBuyQuoteParams: vi.fn(() => ({
          inputMint: SOL_MINT,
          outputMint: 'mint-1',
          amount: '10000000',
          slippageBps: 100,
          swapMode: 'ExactIn' as const
        }))
      }),
      quoteSol: 0.01,
      slippageBps: 100,
      ttlMs: 45_000
    });

    await expect(source.observe(makeCandidate(), {
      strategyId: 'new-token-v1',
      now: new Date('2026-06-21T10:00:00.000Z')
    })).resolves.toMatchObject({
      source: 'jupiter_route',
      status: 'blocked',
      hardRejectReason: 'no-jupiter-sol-route'
    });
  });

  it('records source failures without throwing out of the worker path', async () => {
    const source = createJupiterRouteSource({
      client: makeClient({
        getQuote: vi.fn(async () => {
          throw new Error('jupiter timeout');
        }),
        buildBuyQuoteParams: vi.fn(() => ({
          inputMint: SOL_MINT,
          outputMint: 'mint-1',
          amount: '10000000',
          slippageBps: 100,
          swapMode: 'ExactIn' as const
        }))
      }),
      quoteSol: 0.01,
      slippageBps: 100,
      ttlMs: 45_000
    });

    await expect(source.observe(makeCandidate(), {
      strategyId: 'new-token-v1',
      now: new Date('2026-06-21T10:00:00.000Z')
    })).resolves.toMatchObject({
      source: 'jupiter_route',
      status: 'failed',
      hardRejectReason: 'jupiter-route-check-failed',
      rawJson: {
        error: 'jupiter timeout'
      }
    });
  });
});
