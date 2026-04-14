import { describe, expect, it } from 'vitest';

import { buildOrderIntent } from '../../../src/execution/order-intent-builder';

describe('buildOrderIntent', () => {
  it('builds a deterministic idempotency key from the input', () => {
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z'
    });

    expect(intent.strategyId).toBe('new-token-v1');
    expect(intent.poolAddress).toBe('pool-1');
    expect(intent.outputSol).toBe(0.1);
    expect(intent.idempotencyKey).toBe('new-token-v1:pool-1:2026-03-21T00:00:00.000Z');
    expect(intent.fullPositionExit).toBe(false);
  });

  it('preserves explicit full-position exit semantics for exit actions', () => {
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z',
      side: 'sell',
      tokenMint: 'mint-safe',
      fullPositionExit: true
    });

    expect(intent.side).toBe('sell');
    expect(intent.tokenMint).toBe('mint-safe');
    expect(intent.fullPositionExit).toBe(true);
  });
});
