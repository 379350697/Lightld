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

  it('loads solana execution state and expected signer allowlist config', () => {
    const config = loadSolanaExecutionConfig(envBase({
      SOLANA_EXECUTION_STATE_DIR: '/var/lib/lightld/solana-execution',
      SOLANA_EXPECTED_SIGNER_PUBLIC_KEYS: 'signer-a, signer-b'
    }));

    expect(config.stateRootDir).toBe('/var/lib/lightld/solana-execution');
    expect(config.expectedSignerPublicKeys).toEqual(['signer-a', 'signer-b']);
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

  it('sends transactions with preflight enabled', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const client = new SolanaRpcClient({
      rpcUrl: 'https://write-primary.example',
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: unknown[] };
        calls.push(body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'sig-1' }), { status: 200 });
      }
    });

    await expect(client.sendRawTransaction('tx-base64')).resolves.toBe('sig-1');

    expect(calls[0]).toMatchObject({
      method: 'sendTransaction',
      params: [
        'tx-base64',
        expect.objectContaining({
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        })
      ]
    });
  });

  it('requires a sent transaction to become visible on a read endpoint', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new SolanaRpcClient({
      writeRpcUrls: ['https://write-1.example', 'https://write-2.example'],
      readRpcUrls: ['https://read-1.example', 'https://read-2.example'],
      fetchImpl: async (input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
        const url = String(input);
        calls.push({ url, method: body.method });

        if (body.method === 'sendTransaction') {
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: url.includes('write-1') ? 'sig-dropped' : 'sig-visible'
          }), { status: 200 });
        }

        const visible = url.includes('read-2') && calls.some((call) =>
          call.url.includes('write-2') && call.method === 'sendTransaction'
        );

        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [visible ? {
              slot: 10,
              confirmations: 1,
              err: null,
              confirmationStatus: 'processed'
            } : null]
          }
        }), { status: 200 });
      }
    });

    await expect(client.sendRawTransactionAndWaitForVisibility('tx-base64', {
      visibilityAttempts: 1,
      visibilityDelayMs: 1
    })).resolves.toMatchObject({ signature: 'sig-visible' });

    expect(calls).toEqual([
      { url: 'https://write-1.example', method: 'sendTransaction' },
      { url: 'https://read-1.example', method: 'getSignatureStatuses' },
      { url: 'https://read-2.example', method: 'getSignatureStatuses' },
      { url: 'https://write-2.example', method: 'sendTransaction' },
      { url: 'https://read-1.example', method: 'getSignatureStatuses' },
      { url: 'https://read-2.example', method: 'getSignatureStatuses' }
    ]);
  });

  it('fails when accepted transaction signatures never become visible', async () => {
    const client = new SolanaRpcClient({
      writeRpcUrls: ['https://write-1.example'],
      readRpcUrls: ['https://read-1.example'],
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };

        if (body.method === 'sendTransaction') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'sig-dropped' }), { status: 200 });
        }

        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { value: [null] }
        }), { status: 200 });
      }
    });

    await expect(client.sendRawTransactionAndWaitForVisibility('tx-base64', {
      visibilityAttempts: 1,
      visibilityDelayMs: 1
    })).rejects.toThrow(/not visible after broadcast attempts/);
  });

  it('requests signatures for an address with a limit', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new SolanaRpcClient({
      rpcUrl: 'https://read-primary.example',
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        });

        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: [{ signature: 'sig-1', slot: 1, blockTime: 1_700_000_000 }]
        }), { status: 200 });
      }
    });

    const result = await client.getSignaturesForAddress('wallet-1', { limit: 5 });

    expect(result).toEqual([{ signature: 'sig-1', slot: 1, blockTime: 1_700_000_000 }]);
    expect(calls).toEqual([{
      url: 'https://read-primary.example',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: ['wallet-1', { limit: 5 }]
      }
    }]);
  });

  it('requests parsed transactions for a signature', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new SolanaRpcClient({
      rpcUrl: 'https://read-primary.example',
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        });

        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            slot: 10,
            blockTime: 1_700_000_000,
            meta: {},
            transaction: { signatures: ['sig-1'] }
          }
        }), { status: 200 });
      }
    });

    const result = await client.getTransaction('sig-1');

    expect(result).toEqual({
      slot: 10,
      blockTime: 1_700_000_000,
      meta: {},
      transaction: { signatures: ['sig-1'] }
    });
    expect(calls).toEqual([{
      url: 'https://read-primary.example',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: ['sig-1', { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]
      }
    }]);
  });
});
