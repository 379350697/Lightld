import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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

  it('releases an un-settled reservation exactly once after a definite rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spending-release-'));
    const store = new SpendingLimitsStore(root);

    await store.reserveSpend('order-release', 0.08);
    await store.releaseSpend('order-release');
    await store.releaseSpend('order-release');
    const state = await store.read();

    expect(state.dailySpendSol).toBe(0);
    expect(state.hourlySpendSol).toBe(0);
    expect(state.orderCount).toBe(0);
    expect(state.hourlyOrderCount).toBe(0);
    expect(state.reservations).toEqual([]);
  });

  it('never releases a settled reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spending-settled-release-'));
    const store = new SpendingLimitsStore(root);

    await store.reserveSpend('order-settled', 0.08);
    await store.settleSpend('order-settled', 0.09);
    await store.releaseSpend('order-settled');
    const state = await store.read();

    expect(state.dailySpendSol).toBeCloseTo(0.09);
    expect(state.hourlySpendSol).toBeCloseTo(0.09);
    expect(state.orderCount).toBe(1);
    expect(state.reservations[0]).toMatchObject({
      idempotencyKey: 'order-settled',
      settledSol: 0.09,
      status: 'settled'
    });
  });

  it('rejects an idempotency-key collision with a different requested amount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spending-conflict-'));
    const store = new SpendingLimitsStore(root);

    await store.reserveSpend('order-conflict', 0.08);

    await expect(store.reserveSpend('order-conflict', 0.09)).rejects.toThrow(
      'spending-reservation-conflict:order-conflict'
    );
  });

  it('does not subtract an old-hour release from current-hour reservations', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-17T12:59:00.000Z'));
      const root = await mkdtemp(join(tmpdir(), 'lightld-spending-hour-boundary-'));
      const store = new SpendingLimitsStore(root);

      await store.reserveSpend('order-old-hour', 0.4);
      vi.setSystemTime(new Date('2026-07-17T13:00:00.000Z'));
      await store.reserveSpend('order-current-hour', 0.2);
      await store.releaseSpend('order-old-hour');
      const state = await store.read();

      expect(state.dailySpendSol).toBeCloseTo(0.2);
      expect(state.hourlySpendSol).toBeCloseTo(0.2);
      expect(state.orderCount).toBe(1);
      expect(state.hourlyOrderCount).toBe(1);
      expect(state.reservations).toHaveLength(1);
      expect(state.reservations[0].idempotencyKey).toBe('order-current-hour');
    } finally {
      vi.useRealTimers();
    }
  });
});
