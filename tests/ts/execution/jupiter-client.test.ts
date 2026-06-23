import { describe, expect, it } from 'vitest';

import { NoRpcEndpointAvailableError, RpcEndpointRegistry } from '../../../src/execution/rpc-endpoint-registry';
import {
  JupiterClient,
  JupiterNoRouteError,
  JupiterQuoteAmountTooSmallError
} from '../../../src/execution/solana/jupiter-client';

const quotePayload = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'mint-out',
  inAmount: '1000',
  outAmount: '900',
  otherAmountThreshold: '850',
  swapMode: 'ExactIn',
  slippageBps: 50,
  priceImpactPct: '0',
  routePlan: []
};

describe('JupiterClient', () => {
  it('uses the shared endpoint registry cooldown before retrying a hot endpoint', async () => {
    const registry = new RpcEndpointRegistry({ maxWaitMs: 0 });
    registry.register({
      url: 'https://api.jup.ag',
      kind: 'jupiter',
      maxConcurrency: 1
    });

    let calls = 0;
    const client = new JupiterClient({
      apiUrl: 'https://api.jup.ag',
      endpointRegistry: registry,
      fetchImpl: async () => {
        calls += 1;
        return new Response('busy', { status: 429, statusText: 'Too Many Requests' });
      }
    });

    await expect(
      client.getQuote({
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'mint-out',
        amount: '1000'
      })
    ).rejects.toBeInstanceOf(NoRpcEndpointAvailableError);

    await expect(
      client.getQuote({
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'mint-out',
        amount: '1000'
      })
    ).rejects.toBeInstanceOf(NoRpcEndpointAvailableError);

    expect(calls).toBe(1);
  });

  it('paces quote and swap calls through one sliding window bucket', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const client = new JupiterClient({
      rateLimitCapacity: 1,
      rateLimitWindowMs: 100,
      nowMs: () => now,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        now += delayMs;
      },
      fetchImpl: async () => new Response(JSON.stringify(quotePayload), { status: 200 })
    });

    await client.getQuote({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'mint-out',
      amount: '1000'
    });
    await client.getQuote({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'mint-out',
      amount: '1000'
    });

    expect(sleeps).toEqual([100]);
  });

  it('uses Retry-After from Jupiter 429 responses when cooling the endpoint', async () => {
    const registry = new RpcEndpointRegistry({
      maxWaitMs: 0,
      rateLimitedCooldownMs: 100
    });
    registry.register({
      url: 'https://api.jup.ag',
      kind: 'jupiter',
      maxConcurrency: 1
    });
    const client = new JupiterClient({
      apiUrl: 'https://api.jup.ag',
      endpointRegistry: registry,
      fetchImpl: async () => new Response('busy', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'Retry-After': '2'
        }
      })
    });

    await expect(
      client.getQuote({
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'mint-out',
        amount: '1000'
      })
    ).rejects.toBeInstanceOf(NoRpcEndpointAvailableError);

    const snapshot = registry.snapshots(['https://api.jup.ag'])[0];
    expect(Date.parse(snapshot.cooldownUntil) - Date.parse(snapshot.lastRateLimitedAt)).toBeGreaterThanOrEqual(2_000);
  });

  it('negative-caches Jupiter no-route quote failures', async () => {
    let calls = 0;
    const client = new JupiterClient({
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ errorCode: 'NO_ROUTES_FOUND' }), {
          status: 400,
          statusText: 'Bad Request'
        });
      }
    });
    const quote = {
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'mint-out',
      amount: '1000'
    };

    await expect(client.getQuote(quote)).rejects.toBeInstanceOf(JupiterNoRouteError);
    await expect(client.getQuote(quote)).rejects.toBeInstanceOf(JupiterNoRouteError);
    await expect(client.getQuote({
      ...quote,
      amount: '2000'
    })).rejects.toBeInstanceOf(JupiterNoRouteError);

    expect(calls).toBe(1);
  });

  it('does not ask Jupiter to quote dust amounts', async () => {
    let calls = 0;
    const client = new JupiterClient({
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(quotePayload), { status: 200 });
      }
    });

    await expect(
      client.getQuote({
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'mint-out',
        amount: '999'
      })
    ).rejects.toBeInstanceOf(JupiterQuoteAmountTooSmallError);

    expect(calls).toBe(0);
  });
});
