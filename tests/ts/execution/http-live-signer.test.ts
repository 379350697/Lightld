import { describe, expect, it } from 'vitest';

import { HttpLiveSigner } from '../../../src/execution/http-live-signer';
import { buildOrderIntent } from '../../../src/execution/order-intent-builder';

describe('HttpLiveSigner', () => {
  it('signs a live intent through an external http service', async () => {
    const signer = new HttpLiveSigner({
      url: 'https://sign.example/api',
      fetchImpl: async (_input, init) => {
        expect(init?.method).toBe('POST');

        return new Response(
          JSON.stringify({
            signerId: 'prod-signer',
            signedAt: '2026-03-21T00:00:00.000Z',
            signature: 'prod-signer:sig'
          }),
          { status: 200 }
        );
      }
    });
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z'
    });

    await expect(signer.sign(intent)).resolves.toEqual({
      intent,
      signerId: 'prod-signer',
      signedAt: '2026-03-21T00:00:00.000Z',
      signature: 'prod-signer:sig'
    });
  });

  it('returns the canonical intent supplied by the signer response', async () => {
    const intent = {
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z',
      idempotencyKey: 'new-token-v1:pool-1:2026-03-21T00:00:00.000Z',
      executionPolicy: 'broadcast',
      side: 'add-lp',
      tokenMint: 'mint-1',
      openIntentId: 'lp-open-intent:identity-1',
      positionId: 'pool-1:mint-1',
      chainPositionAddress: 'chain-position-1'
    } as const;
    const canonicalIntent = {
      ...intent,
      fullPositionExit: false,
      liquidateResidualTokenToSol: false
    };
    const signer = new HttpLiveSigner({
      url: 'https://sign.example/api',
      fetchImpl: async () => new Response(
        JSON.stringify({
          intent: canonicalIntent,
          signerId: 'prod-signer',
          signedAt: '2026-03-21T00:00:00.000Z',
          signature: 'prod-signer:sig'
        }),
        { status: 200 }
      )
    });

    await expect(signer.sign(intent as any)).resolves.toMatchObject({
      intent: canonicalIntent,
      signerId: 'prod-signer'
    });
  });
});
