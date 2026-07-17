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
    expect(intent.executionPolicy).toBe('broadcast');
    expect(intent.fullPositionExit).toBe(false);
  });

  it('binds the paper-only execution policy into the signed intent payload', () => {
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      executionPolicy: 'simulate-only',
      createdAt: '2026-03-21T00:00:00.000Z'
    });

    expect(intent.executionPolicy).toBe('simulate-only');
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

  it('carries lifecycle identity through the execution boundary', () => {
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z',
      side: 'withdraw-lp',
      tokenMint: 'mint-safe',
      openIntentId: 'lp-open-intent:1',
      positionId: 'position-1',
      chainPositionAddress: 'chain-position-1',
      preExitTokenAmountRaw: '9007199254740993000'
    });

    expect(intent.openIntentId).toBe('lp-open-intent:1');
    expect(intent.positionId).toBe('position-1');
    expect(intent.chainPositionAddress).toBe('chain-position-1');
    expect(intent.preExitTokenAmountRaw).toBe('9007199254740993000');
  });

  it('binds strategy execution limits and exact input amounts into the signed intent', () => {
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-21T00:00:00.000Z',
      side: 'sell',
      tokenMint: 'mint-safe',
      fullPositionExit: true,
      maxSlippageBps: 80,
      maxImpactBps: 150,
      inputAmountRaw: '9007199254740993000'
    });

    expect(intent).toMatchObject({
      maxSlippageBps: 80,
      maxImpactBps: 150,
      inputAmountRaw: '9007199254740993000'
    });
  });
});
