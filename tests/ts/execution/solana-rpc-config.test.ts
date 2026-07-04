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
    expect(config.readRpcUrls[0]).toContain('mainnet.helius-rpc.com');
    expect(config.readRpcUrls.at(-1)).toContain('alchemy.com');
    expect(config.dlmmRpcUrl).toContain('mainnet.helius-rpc.com');
    expect(config.dlmmRpcUrls.at(-1)).toContain('alchemy.com');
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


  it('loads conservative endpoint rate-limit controls', () => {
    const defaults = loadSolanaExecutionConfig(envBase());
    expect(defaults.rpc429CooldownMs).toBe(120_000);
    expect(defaults.rpcEndpointMinIntervalMs).toBe(500);
    expect(defaults.jupiterRateLimitCapacity).toBe(60);
    expect(defaults.jupiterRateLimitWindowMs).toBe(60_000);
    expect(defaults.jupiterNegativeRouteCacheTtlMs).toBe(300_000);
    expect(defaults.jupiterMinQuoteAmountLamports).toBe(1_000);
    expect(defaults.swapProviderOrder).toEqual([
      'meteora-direct',
      'jupiter-v2',
      'raydium',
      'okx',
      'jupiter-v1'
    ]);
    expect(defaults.swapProviderCooldownMs).toBe(30_000);
    expect(defaults.raydiumTradeApiUrl).toBe('https://transaction-v1.raydium.io');
    expect(defaults.okxDexApiUrl).toBe('https://web3.okx.com');
    expect(defaults.okxDexChainIndex).toBe('501');
    expect(defaults.residualTokenMinValueSol).toBe(0.1);
    expect(defaults.residualTokenDustMaxUiAmount).toBe(0.00001);

    const config = loadSolanaExecutionConfig(envBase({
      RPC_429_COOLDOWN_MS: '45000',
      RPC_ENDPOINT_MIN_INTERVAL_MS: '125',
      JUPITER_RATE_LIMIT_CAPACITY: '100',
      JUPITER_RATE_LIMIT_WINDOW_MS: '10000',
      JUPITER_NEGATIVE_ROUTE_CACHE_TTL_MS: '60000',
      JUPITER_MIN_QUOTE_LAMPORTS: '5000',
      SWAP_PROVIDER_ORDER: 'raydium,jupiter-v1',
      SWAP_PROVIDER_COOLDOWN_MS: '9000',
      RAYDIUM_TRADE_API_URL: 'https://raydium.example',
      OKX_DEX_API_URL: 'https://okx.example',
      OKX_DEX_CHAIN_INDEX: 'solana-mainnet',
      OKX_DEX_API_KEY: 'okx-key',
      OKX_DEX_SECRET_KEY: 'okx-secret',
      OKX_DEX_PASSPHRASE: 'okx-passphrase',
      LIVE_RESIDUAL_TOKEN_SWEEP_MIN_VALUE_SOL: '0.05',
      SOLANA_RESIDUAL_TOKEN_DUST_MAX_UI_AMOUNT: '0.00002'
    }));
    expect(config.rpc429CooldownMs).toBe(45_000);
    expect(config.rpcEndpointMinIntervalMs).toBe(125);
    expect(config.jupiterRateLimitCapacity).toBe(100);
    expect(config.jupiterRateLimitWindowMs).toBe(10_000);
    expect(config.jupiterNegativeRouteCacheTtlMs).toBe(60_000);
    expect(config.jupiterMinQuoteAmountLamports).toBe(5_000);
    expect(config.swapProviderOrder).toEqual(['raydium', 'jupiter-v1']);
    expect(config.swapProviderCooldownMs).toBe(9_000);
    expect(config.raydiumTradeApiUrl).toBe('https://raydium.example');
    expect(config.okxDexApiUrl).toBe('https://okx.example');
    expect(config.okxDexChainIndex).toBe('solana-mainnet');
    expect(config.okxDexApiKey).toBe('okx-key');
    expect(config.okxDexSecretKey).toBe('okx-secret');
    expect(config.okxDexPassphrase).toBe('okx-passphrase');
    expect(config.residualTokenMinValueSol).toBe(0.05);
    expect(config.residualTokenDustMaxUiAmount).toBe(0.00002);
  });

  it('lets the solana residual token threshold override the daemon fallback', () => {
    const config = loadSolanaExecutionConfig(envBase({
      LIVE_RESIDUAL_TOKEN_SWEEP_MIN_VALUE_SOL: '0.05',
      SOLANA_RESIDUAL_TOKEN_MIN_VALUE_SOL: '0.02'
    }));

    expect(config.residualTokenMinValueSol).toBe(0.02);
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

  it('preserves RPC simulation logs in send transaction errors', async () => {
    const client = new SolanaRpcClient({
      rpcUrl: 'https://write-primary.example',
      fetchImpl: async () => new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32002,
          message: 'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1',
          data: {
            logs: [
              'Program 11111111111111111111111111111111 invoke [1]',
              'Program log: Error Code: InsufficientFunds',
              'Program 11111111111111111111111111111111 failed: custom program error: 0x1'
            ]
          }
        }
      }), { status: 200 })
    });

    await expect(client.sendRawTransaction('tx-base64')).rejects.toThrow(
      /Program log: Error Code: InsufficientFunds/
    );
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
