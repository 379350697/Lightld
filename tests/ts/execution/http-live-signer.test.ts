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
});
