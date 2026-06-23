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



  it('uses registry cooldown options for classified rate limits', async () => {
    const registry = new RpcEndpointRegistry({ maxWaitMs: 0, rateLimitedCooldownMs: 120_000 });
    registry.register({
      url: 'https://rpc-a.example',
      kind: 'dlmm',
      maxConcurrency: 1
    });

    await expect(
      registry.runWithEndpoint({
        kind: 'dlmm',
        candidates: ['https://rpc-a.example'],
        execute: async () => {
          throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        },
        classifyError: () => ({ retryable: true, reason: 'rate-limited', cooldownMs: 30_000 })
      })
    ).rejects.toBeInstanceOf(NoRpcEndpointAvailableError);

    const snapshot = registry.snapshots(['https://rpc-a.example'])[0];
    expect(Date.parse(snapshot.cooldownUntil) - Date.parse(snapshot.lastRateLimitedAt)).toBe(120_000);
  });

  it('paces repeated starts against the same endpoint', async () => {
    const registry = new RpcEndpointRegistry({ maxWaitMs: 100, minRequestIntervalMs: 20 });
    registry.register({
      url: 'https://rpc-paced.example',
      kind: 'solana-read',
      maxConcurrency: 1
    });

    const startedAt: number[] = [];
    const run = () =>
      registry.runWithEndpoint({
        kind: 'solana-read',
        candidates: ['https://rpc-paced.example'],
        execute: async () => {
          startedAt.push(Date.now());
          return 'ok';
        },
        classifyError: () => null
      });

    await run();
    await run();

    expect(startedAt).toHaveLength(2);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(15);
  });

  it('keeps recent rate-limit strikes across a quick successful probe', async () => {
    const registry = new RpcEndpointRegistry({
      maxWaitMs: 0,
      rateLimitedCooldownMs: 10,
      rateLimitFailureDecayMs: 60_000
    });
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
        classifyError: () => ({ retryable: true, reason: 'rate-limited', cooldownMs: 10 })
      })
    ).rejects.toBeInstanceOf(NoRpcEndpointAvailableError);

    await new Promise((resolve) => setTimeout(resolve, 15));

    await expect(
      registry.runWithEndpoint({
        kind: 'solana-read',
        candidates: ['https://rpc-a.example'],
        execute: async () => 'recovered',
        classifyError: () => null
      })
    ).resolves.toBe('recovered');

    await expect(
      registry.runWithEndpoint({
        kind: 'solana-read',
        candidates: ['https://rpc-a.example'],
        execute: async () => {
          throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        },
        classifyError: () => ({ retryable: true, reason: 'rate-limited', cooldownMs: 10 })
      })
    ).rejects.toBeInstanceOf(NoRpcEndpointAvailableError);

    expect(registry.snapshots(['https://rpc-a.example'])[0]).toMatchObject({
      rateLimitStrikes: 2,
      lastFailureReason: 'rate-limited'
    });
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
