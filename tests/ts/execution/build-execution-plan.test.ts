import { describe, expect, it } from 'vitest';

import { buildExecutionPlan } from '../../../src/execution/build-execution-plan';

describe('buildExecutionPlan', () => {
  it('uses the provided quote when building a plan', () => {
    const plan = buildExecutionPlan({
      strategyId: 'new-token-v1',
      targetPool: 'pool-1',
      quote: {
        routeExists: true,
        outputSol: 0.25,
        slippageBps: 50,
        quotedAt: '2026-03-21T00:00:00.000Z',
        stale: false
      }
    });

    expect(plan.strategyId).toBe('new-token-v1');
    expect(plan.poolAddress).toBe('pool-1');
    expect(plan.exitMint).toBe('SOL');
    expect(plan.solExitQuote.outputSol).toBe(0.25);
  });
});
