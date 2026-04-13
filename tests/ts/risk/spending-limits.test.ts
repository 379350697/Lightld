import { describe, expect, it } from 'vitest';

import {
  createEmptySpendingLimitsState,
  evaluateSpendingLimits,
  type SpendingLimitsConfig,
  type SpendingLimitsState
} from '../../../src/risk/spending-limits';

const DEFAULT_CONFIG: SpendingLimitsConfig = {
  maxSingleOrderSol: 0.5,
  maxDailySpendSol: 2.0,
  dailySpendResetHour: 0
};

function makeState(overrides: Partial<SpendingLimitsState> = {}): SpendingLimitsState {
  return {
    ...createEmptySpendingLimitsState(0),
    ...overrides
  };
}

describe('evaluateSpendingLimits', () => {
  it('allows a normal order within both limits', () => {
    const result = evaluateSpendingLimits(DEFAULT_CONFIG, makeState(), 0.1);

    expect(result).toEqual({
      allowed: true,
      reason: 'spending-allowed'
    });
  });

  it('blocks when single order exceeds limit', () => {
    const result = evaluateSpendingLimits(DEFAULT_CONFIG, makeState(), 0.6);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('single-order-limit-exceeded');
  });

  it('blocks when daily cumulative spend would be exceeded', () => {
    const state = makeState({ dailySpendSol: 1.8 });
    const result = evaluateSpendingLimits(DEFAULT_CONFIG, state, 0.3);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('daily-spend-limit-exceeded');
  });

  it('allows an order that exactly hits the daily limit', () => {
    const state = makeState({ dailySpendSol: 1.5 });
    const result = evaluateSpendingLimits(DEFAULT_CONFIG, state, 0.5);

    expect(result).toEqual({
      allowed: true,
      reason: 'spending-allowed'
    });
  });

  it('resets daily spend when the date changes', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const state = makeState({
      dailySpendSol: 10,
      orderCount: 50,
      lastResetDate: yesterday
    });
    const result = evaluateSpendingLimits(DEFAULT_CONFIG, state, 0.1);

    expect(result).toEqual({
      allowed: true,
      reason: 'spending-allowed'
    });
  });

  it('single order limit takes priority over daily limit', () => {
    const result = evaluateSpendingLimits(DEFAULT_CONFIG, makeState(), 0.6);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('single-order-limit-exceeded');
  });
});
