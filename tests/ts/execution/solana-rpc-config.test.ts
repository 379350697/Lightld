import { describe, expect, it } from 'vitest';

import { RpcEndpointRegistry } from '../../../src/execution/rpc-endpoint-registry';
import { loadSolanaExecutionConfig } from '../../../src/execution/solana/solana-execution-config';
import { SolanaRpcClient } from '../../../src/execution/solana/solana-rpc-client';

function envBase(overrides: Record<string, string | undefined> = {}) {
  return {
    SOLANA_KEYPAIR_PATH: '/tmp/id.json',
    ...overrides
  };
}

describe('solana rpc config policy', () => {
  it('builds default trade and read rpc tiers', () => {
    const config = loadSolanaExecutionConfig(envBase());

    expect(config.writeRpcUrls.length).toBeGreaterThanOrEqual(4);
    expect(config.readRpcUrls.length).toBeGreaterThan(config.writeRpcUrls.length - 1);
    expect(config.writeRpcUrls[0]).toContain('mainnet.helius-rpc.com');
    expect(config.readRpcUrls[0]).toContain('alchemy.com');
    expect(config.dlmmRpcUrl).toContain('alchemy.com');
    expect(config.dlmmRpcUrls[0]).toContain('alchemy.com');
    expect(config.dlmmRpcUrls).toContain(config.readRpcUrls[0]);
  });

  it('accepts explicit write/read/query overrides', () => {
    const config = loadSolanaExecutionConfig(envBase({
      SOLANA_RPC_URL: 'https://trade-primary.example',
      SOLANA_RPC_WRITE_URLS: 'https://trade-a.example,https://trade-b.example',
      SOLANA_QUERY_RPC_URL: 'https://query-primary.example',
      SOLANA_RPC_READ_URLS: 'https://read-a.example,https://read-b.example',
      SOLANA_DLMM_RPC_URL: 'https://dlmm.example'
    }));

    expect(config.writeRpcUrls.slice(0, 3)).toEqual([
      'https://trade-a.example',
      'https://trade-b.example',
      'https://trade-primary.example'
    ]);
    expect(config.readRpcUrls.slice(0, 3)).toEqual([
      'https://read-a.example',
      'https://read-b.example',
      'https://query-primary.example'
    ]);
    expect(config.rpcUrl).toBe('https://trade-a.example');
    expect(config.dlmmRpcUrl).toBe('https://dlmm.example');
    expect(config.dlmmRpcUrls.slice(0, 4)).toEqual([
      'https://dlmm.example',
      'https://query-primary.example',
      'https://read-a.example',
      'https://read-b.example'
    ]);
  });

  it('keeps dlmm explicit rpc first but appends the read pool as fallback endpoints', () => {
    const config = loadSolanaExecutionConfig(envBase({
      SOLANA_RPC_READ_URLS: 'https://read-a.example,https://read-b.example',
      SOLANA_DLMM_RPC_URL: 'https://dlmm-primary.example'
    }));

    expect(config.dlmmRpcUrls.slice(0, 3)).toEqual([
      'https://dlmm-primary.example',
      'https://read-a.example',
      'https://read-b.example'
    ]);
  });

  it('rpc client retries write and read urls in order', async () => {
    const calls: string[] = [];
    const registry = new RpcEndpointRegistry({ maxWaitMs: 0 });
    registry.registerMany([
      { url: 'https://write-1.example', kind: 'solana-write', maxConcurrency: 1 },
      { url: 'https://write-2.example', kind: 'solana-write', maxConcurrency: 1 },
      { url: 'https://read-1.example', kind: 'solana-read', maxConcurrency: 1 },
      { url: 'https://read-2.example', kind: 'solana-read', maxConcurrency: 1 }
    ]);
    const client = new SolanaRpcClient({
      writeRpcUrls: ['https://write-1.example', 'https://write-2.example'],
      readRpcUrls: ['https://read-1.example', 'https://read-2.example'],
      endpointRegistry: registry,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(url);
        const payload = JSON.parse(String(init?.body ?? '{}')) as { method: string };

        if (url.includes('write-1') || url.includes('read-1')) {
          throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        }

        if (payload.method === 'sendTransaction') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'tx-ok' }), { status: 200 });
        }

        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 123 } }), { status: 200 });
      }
    });

    await expect(client.sendRawTransaction('abc')).resolves.toBe('tx-ok');
    await expect(client.getBalance('wallet')).resolves.toBe(123);
    expect(calls).toEqual([
      'https://write-1.example',
      'https://write-2.example',
      'https://read-1.example',
      'https://read-2.example'
    ]);
  });
});
