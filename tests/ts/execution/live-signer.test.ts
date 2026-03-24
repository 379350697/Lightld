import { describe, expect, it } from 'vitest';

import { buildOrderIntent } from '../../../src/execution/order-intent-builder';
import { TestLiveSigner } from '../../../src/execution/live-signer';

describe('TestLiveSigner', () => {
  it('signs an order intent with deterministic metadata', async () => {
    const signer = new TestLiveSigner('test-signer');
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z'
    });

    const signed = await signer.sign(intent);

    expect(signed.signerId).toBe('test-signer');
    expect(signed.signature).toContain(intent.idempotencyKey);
    expect(signed.intent.idempotencyKey).toBe(intent.idempotencyKey);
  });
});
