import { describe, expect, it } from 'vitest';

import { NoRpcEndpointAvailableError, RpcEndpointRegistry } from '../../../src/execution/rpc-endpoint-registry';
import { JupiterClient } from '../../../src/execution/solana/jupiter-client';

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
});
