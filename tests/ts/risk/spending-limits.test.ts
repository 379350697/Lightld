import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createEmptySpendingLimitsState,
  evaluateSpendingLimits,
  SpendingLimitsStore,
  type SpendingLimitsConfig,
  type SpendingLimitsState
} from '../../../src/risk/spending-limits';

const DEFAULT_CONFIG: SpendingLimitsConfig = {
  maxSingleOrderSol: 0.5,
  maxHourlySpendSol: 1.0,
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

  it('blocks when hourly cumulative spend would be exceeded', () => {
    const state = makeState({ hourlySpendSol: 0.8 });
    const result = evaluateSpendingLimits(DEFAULT_CONFIG, state, 0.3);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('hourly-spend-limit-exceeded');
  });

  it('allows an order that exactly hits the daily limit', () => {
    const state = makeState({ dailySpendSol: 1.5, hourlySpendSol: 0.5 });
    const result = evaluateSpendingLimits(DEFAULT_CONFIG, state, 0.5);

    expect(result).toEqual({
      allowed: true,
      reason: 'spending-allowed'
    });
  });

  it('resets hourly spend when the hour changes', () => {
    const previousHour = new Date(Date.now() - 60 * 60_000).toISOString().slice(0, 13);
    const state = makeState({
      dailySpendSol: 1.0,
      hourlySpendSol: 10,
      hourlyOrderCount: 50,
      lastHourlyResetAt: previousHour
    });
    const result = evaluateSpendingLimits(DEFAULT_CONFIG, state, 0.1);

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

  it('resets persisted daily and hourly spend for test restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spending-reset-'));
    const store = new SpendingLimitsStore(root);

    await store.recordSpend(0.4);
    await store.reset();
    const state = await store.read();

    expect(state.dailySpendSol).toBe(0);
    expect(state.hourlySpendSol).toBe(0);
    expect(state.orderCount).toBe(0);
    expect(state.hourlyOrderCount).toBe(0);
  });

  it('settles a requested reservation to the trusted actual spend amount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spending-settle-'));
    const store = new SpendingLimitsStore(root);

    await store.reserveSpend('order-1', 0.08);
    await store.settleSpend('order-1', 0.137416044);
    const state = await store.read();

    expect(state.dailySpendSol).toBeCloseTo(0.137416044);
    expect(state.hourlySpendSol).toBeCloseTo(0.137416044);
    expect(state.orderCount).toBe(1);
    expect(state.reservations[0]).toMatchObject({
      idempotencyKey: 'order-1',
      requestedSol: 0.08,
      settledSol: 0.137416044,
      status: 'settled'
    });
  });
});
