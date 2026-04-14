import { describe, expect, it } from 'vitest';

import { TestLiveBroadcaster } from '../../../src/execution/live-broadcaster';
import { buildOrderIntent } from '../../../src/execution/order-intent-builder';
import { TestLiveSigner } from '../../../src/execution/live-signer';

describe('TestLiveBroadcaster', () => {
  it('returns a submitted result for signed live orders', async () => {
    const signer = new TestLiveSigner('test-signer');
    const broadcaster = new TestLiveBroadcaster();
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z'
    });

    const signed = await signer.sign(intent);
    const result = await broadcaster.broadcast(signed);

    expect(result.status).toBe('submitted');
    if (result.status !== 'submitted') {
      throw new Error('expected a submitted result');
    }
    expect(result.submissionId).toContain('test-signer');
    expect(result.idempotencyKey).toBe(intent.idempotencyKey);
  });

  it('classifies broadcast failures', async () => {
    const signer = new TestLiveSigner('test-signer');
    const broadcaster = new TestLiveBroadcaster(new Error('timeout while sending'));
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z'
    });

    const signed = await signer.sign(intent);
    const result = await broadcaster.broadcast(signed);

    expect(result).toEqual({
      status: 'failed',
      reason: 'timeout while sending',
      retryable: true,
      idempotencyKey: intent.idempotencyKey
    });
  });
});
