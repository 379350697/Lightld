import { describe, expect, it } from 'vitest';

import {
  NoRpcEndpointAvailableError,
  RpcEndpointRegistry
} from '../../../src/execution/rpc-endpoint-registry';

describe('RpcEndpointRegistry', () => {
  it('cools a rate-limited endpoint and skips it on the next selection', async () => {
    const registry = new RpcEndpointRegistry({ maxWaitMs: 0 });
    registry.registerMany([
      { url: 'https://rpc-a.example', kind: 'solana-read', maxConcurrency: 1 },
      { url: 'https://rpc-b.example', kind: 'solana-read', maxConcurrency: 1 }
    ]);

    const calls: string[] = [];

    await expect(
      registry.runWithEndpoint({
        kind: 'solana-read',
        candidates: ['https://rpc-a.example', 'https://rpc-b.example'],
        execute: async (url) => {
          calls.push(url);
          if (url.includes('rpc-a')) {
            throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
          }

          return 'ok';
        },
        classifyError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          return /429/.test(message)
            ? { retryable: true, reason: 'rate-limited', cooldownMs: 30_000 }
            : null;
        }
      })
    ).resolves.toBe('ok');

    await expect(
      registry.runWithEndpoint({
        kind: 'solana-read',
        candidates: ['https://rpc-a.example', 'https://rpc-b.example'],
        execute: async (url) => {
          calls.push(url);
          return 'ok-2';
        },
        classifyError: () => null
      })
    ).resolves.toBe('ok-2');

    expect(calls).toEqual([
      'https://rpc-a.example',
      'https://rpc-b.example',
      'https://rpc-b.example'
    ]);
  });

  it('waits for an inflight slot instead of overfilling the same endpoint', async () => {
    const registry = new RpcEndpointRegistry({ maxWaitMs: 50 });
    registry.register({
      url: 'https://rpc-a.example',
      kind: 'solana-read',
      maxConcurrency: 1
    });

    let concurrent = 0;
    let peakConcurrent = 0;

    const run = () =>
      registry.runWithEndpoint({
        kind: 'solana-read',
        candidates: ['https://rpc-a.example'],
        execute: async () => {
          concurrent += 1;
          peakConcurrent = Math.max(peakConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent -= 1;
          return 'ok';
        },
        classifyError: () => null
      });

    await Promise.all([run(), run()]);

    expect(peakConcurrent).toBe(1);
  });

  it('throws a clear error when every candidate is cooling down', async () => {
    const registry = new RpcEndpointRegistry({ maxWaitMs: 0 });
    registry.register({
      url: 'https://rpc-a.example',
      kind: 'solana-read',
      maxConcurrency: 1
    });

    await expect(
      registry.runWithEndpoint({
        kind: 'solana-read',
        candidates: ['https://rpc-a.example'],
        execute: async () => {
          throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        },
        classifyError: () => ({
          retryable: true,
          reason: 'rate-limited',
          cooldownMs: 30_000
        })
      })
    ).rejects.toBeInstanceOf(NoRpcEndpointAvailableError);
  });
});
