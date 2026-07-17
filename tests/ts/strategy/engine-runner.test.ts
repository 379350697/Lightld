import { describe, expect, it } from 'vitest';

import { runEngineCycle } from '../../../src/strategy/engine-runner';

describe('runEngineCycle', () => {
  it('returns dca-out for actionable new-token snapshots', () => {
    const result = runEngineCycle({
      engine: 'new-token',
      snapshot: {
        inSession: true,
        hasInventory: true,
        hasSolRoute: true,
        liquidityUsd: 10_000
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000
      }
    });

    expect(result.action).toBe('dca-out');
    expect(result.audit.reason).toBe('spot-has-inventory-no-pnl');
  });

  it('returns deploy for new-token when no inventory and hard gates pass', () => {
    const result = runEngineCycle({
      engine: 'new-token',
      snapshot: {
        inSession: true,
        hasInventory: false,
        hasSolRoute: true,
        liquidityUsd: 15_000
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000
      }
    });

    expect(result.action).toBe('deploy');
    expect(result.audit.reason).toBe('spot-open-approved');
  });

  it('lets existing new-token LP exits bypass entry hard gates', () => {
    const result = runEngineCycle({
      engine: 'new-token',
      snapshot: {
        inSession: true,
        hasInventory: true,
        hasLpPosition: true,
        hasSolRoute: false,
        liquidityUsd: 0,
        lpNetPnlPct: -25
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000,
        lpEnabled: true,
        lpStopLossNetPnlPct: -20
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('lp-stop-loss');
  });

  it('lets residual new-token inventory exit after LP closure even when entry gates now fail', () => {
    const result = runEngineCycle({
      engine: 'new-token',
      snapshot: {
        inSession: true,
        hasInventory: true,
        hasLpPosition: false,
        lifecycleState: 'inventory_exit_ready',
        hasSolRoute: false,
        liquidityUsd: 0
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000,
        lpEnabled: true
      }
    });

    expect(result.action).toBe('dca-out');
    expect(result.audit.reason).toBe('inventory-exit-ready');
  });

  it('passes configured maxHoldHours through to LP exit policy', () => {
    const result = runEngineCycle({
      engine: 'new-token',
      snapshot: {
        inSession: true,
        hasInventory: true,
        hasLpPosition: true,
        hasSolRoute: false,
        liquidityUsd: 0,
        holdTimeMs: 9 * 60 * 60 * 1000
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000,
        lpEnabled: true,
        maxHoldHours: 8
      }
    });

    expect(result.action).toBe('withdraw-lp');
    expect(result.audit.reason).toBe('max-hold-with-lp-position');
  });

  it('returns hold when hard gates reject the snapshot', () => {
    const result = runEngineCycle({
      engine: 'large-pool',
      snapshot: {
        hasSolRoute: false,
        liquidityUsd: 1_000
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 5_000
      }
    });

    expect(result.action).toBe('hold');
    expect(result.audit.reason).toContain('missing-sol-route');
  });

  it('runs large-pool exit policy without reapplying entry hard gates', () => {
    const result = runEngineCycle({
      engine: 'large-pool',
      snapshot: {
        inSession: true,
        hasInventory: true,
        lifecycleState: 'open',
        unrealizedPct: -8,
        hasSolRoute: false,
        liquidityUsd: 0
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 20_000,
        stopLossPct: 8
      }
    });

    expect(result.action).toBe('dca-out');
    expect(result.audit.reason).toBe('stop-loss');
  });

  it('passes lifecycle and max hold inputs into the large-pool engine', () => {
    const result = runEngineCycle({
      engine: 'large-pool',
      snapshot: {
        inSession: true,
        hasInventory: true,
        lifecycleState: 'open',
        holdTimeMs: 3 * 60 * 60 * 1000,
        hasSolRoute: true,
        liquidityUsd: 30_000
      },
      config: {
        requireSolRoute: true,
        minLiquidityUsd: 20_000,
        maxHoldHours: 2
      }
    });

    expect(result.action).toBe('dca-out');
    expect(result.audit.reason).toBe('max-hold-with-inventory');
  });
});

