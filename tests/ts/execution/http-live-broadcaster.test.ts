import { describe, expect, it } from 'vitest';

import { HttpLiveBroadcaster } from '../../../src/execution/http-live-broadcaster';
import { buildOrderIntent } from '../../../src/execution/order-intent-builder';
import { TestLiveSigner } from '../../../src/execution/live-signer';

describe('HttpLiveBroadcaster', () => {
  it('uses a safer default timeout for synchronous broadcast flows', () => {
    const broadcaster = new HttpLiveBroadcaster({
      url: 'https://broadcast.example/api'
    });

    expect((broadcaster as unknown as { timeoutMs: number }).timeoutMs).toBe(15_000);
  });

  it('accepts an explicit timeout override', () => {
    const broadcaster = new HttpLiveBroadcaster({
      url: 'https://broadcast.example/api',
      timeoutMs: 22_000
    });

    expect((broadcaster as unknown as { timeoutMs: number }).timeoutMs).toBe(22_000);
  });

  it('broadcasts through an external http service', async () => {
    const signer = new TestLiveSigner('prod-signer');
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z'
    });
    const signedIntent = await signer.sign(intent);
    const broadcaster = new HttpLiveBroadcaster({
      url: 'https://broadcast.example/api',
      fetchImpl: async (_input, init) => {
        expect(init?.method).toBe('POST');

        return new Response(
          JSON.stringify({
            status: 'submitted',
            submissionId: 'sub-1',
            idempotencyKey: intent.idempotencyKey,
            confirmationSignature: 'tx-sig-1'
          }),
          { status: 200 }
        );
      }
    });

    await expect(broadcaster.broadcast(signedIntent)).resolves.toEqual({
      status: 'submitted',
      submissionId: 'sub-1',
      idempotencyKey: intent.idempotencyKey,
      confirmationSignature: 'tx-sig-1'
    });
  });
});
