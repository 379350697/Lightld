import { describe, expect, it } from 'vitest';

import { buildLargePoolDecision } from '../../../src/strategy/engines/large-pool-engine';

describe('buildLargePoolDecision', () => {
  it('deploys only when the session is active and there is no inventory', () => {
    expect(buildLargePoolDecision({ inSession: true, hasInventory: false })).toEqual({
      action: 'deploy',
      reason: 'criteria-met'
    });
    expect(buildLargePoolDecision({ inSession: false, hasInventory: false })).toEqual({
      action: 'hold',
      reason: 'out-of-session'
    });
  });

  it('holds an existing position while no exit condition is met', () => {
    expect(buildLargePoolDecision({
      inSession: true,
      hasInventory: true,
      lifecycleState: 'open',
      unrealizedPct: 3,
      holdTimeMs: 60_000
    }, {
      takeProfitPct: 10,
      stopLossPct: 5,
      maxHoldHours: 2
    })).toEqual({
      action: 'hold',
      reason: 'position-maintain'
    });
  });

  it.each([
    [{ unrealizedPct: 10 }, 'take-profit'],
    [{ unrealizedPct: -5 }, 'stop-loss'],
    [{ holdTimeMs: 2 * 60 * 60 * 1000 }, 'max-hold-with-inventory']
  ])('exits existing inventory when the configured boundary is reached: %s', (partial, reason) => {
    expect(buildLargePoolDecision({
      inSession: true,
      hasInventory: true,
      lifecycleState: 'open',
      ...partial
    }, {
      takeProfitPct: 10,
      stopLossPct: 5,
      maxHoldHours: 2
    })).toEqual({ action: 'dca-out', reason });
  });

  it('flattens existing inventory outside the entry session', () => {
    expect(buildLargePoolDecision({
      inSession: false,
      hasInventory: true,
      lifecycleState: 'open'
    })).toEqual({
      action: 'dca-out',
      reason: 'out-of-session-with-inventory'
    });
  });

  it('continues an explicit inventory exit regardless of the entry-session state', () => {
    expect(buildLargePoolDecision({
      inSession: false,
      hasInventory: true,
      lifecycleState: 'inventory_exit_ready'
    })).toEqual({
      action: 'dca-out',
      reason: 'inventory-exit-ready'
    });
  });

  it('does not duplicate an exit while its lifecycle is pending', () => {
    expect(buildLargePoolDecision({
      inSession: true,
      hasInventory: true,
      lifecycleState: 'inventory_exit_pending'
    })).toEqual({
      action: 'hold',
      reason: 'lifecycle-inventory_exit_pending'
    });
  });

  it('does not reopen when lifecycle evidence still says the position is open', () => {
    expect(buildLargePoolDecision({
      inSession: true,
      hasInventory: false,
      lifecycleState: 'open'
    })).toEqual({
      action: 'hold',
      reason: 'lifecycle-open-without-inventory'
    });
  });

  it('uses backwards-compatible defaults when exit thresholds are absent', () => {
    expect(buildLargePoolDecision({
      inSession: true,
      hasInventory: true,
      unrealizedPct: 50
    })).toEqual({ action: 'dca-out', reason: 'take-profit' });
    expect(buildLargePoolDecision({
      inSession: true,
      hasInventory: true,
      unrealizedPct: -20
    })).toEqual({ action: 'dca-out', reason: 'stop-loss' });
  });
});
