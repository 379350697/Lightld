export type LargePoolSnapshot = {
  inSession: boolean;
  hasInventory: boolean;
  unrealizedPct?: number;
  holdTimeMs?: number;
  lifecycleState?: string;
};

export type LargePoolConfig = {
  takeProfitPct?: number;
  stopLossPct?: number;
  maxHoldHours?: number;
};

export type LargePoolDecision = {
  action: 'deploy' | 'dca-out' | 'hold';
  reason: string;
};

const DEFAULT_TAKE_PROFIT_PCT = 50;
const DEFAULT_STOP_LOSS_PCT = 20;
const DEFAULT_MAX_HOLD_HOURS = 18;

const NON_ACTIONABLE_LIFECYCLE_STATES = new Set([
  'open_pending',
  'lp_exit_pending',
  'inventory_exit_pending',
  'reconcile_required',
  'failed_terminal'
]);

/**
 * Large-pool is a spot-position state machine. Entry gates are evaluated by
 * the runner before this function; this decision only opens when there is no
 * existing exposure and manages existing inventory until it is fully exited.
 */
export function buildLargePoolDecision(
  snapshot: LargePoolSnapshot,
  config: LargePoolConfig = {}
): LargePoolDecision {
  if (snapshot.lifecycleState === 'inventory_exit_ready') {
    return { action: 'dca-out', reason: 'inventory-exit-ready' };
  }

  if (snapshot.lifecycleState && NON_ACTIONABLE_LIFECYCLE_STATES.has(snapshot.lifecycleState)) {
    return { action: 'hold', reason: `lifecycle-${snapshot.lifecycleState}` };
  }

  if (snapshot.hasInventory) {
    if (snapshot.lifecycleState === 'closed') {
      return { action: 'dca-out', reason: 'closed-with-inventory' };
    }

    if (!snapshot.inSession) {
      return { action: 'dca-out', reason: 'out-of-session-with-inventory' };
    }

    const maxHoldHours = config.maxHoldHours ?? DEFAULT_MAX_HOLD_HOURS;
    const maxHoldMs = maxHoldHours * 60 * 60 * 1000;
    if (typeof snapshot.holdTimeMs === 'number' && snapshot.holdTimeMs >= maxHoldMs) {
      return { action: 'dca-out', reason: 'max-hold-with-inventory' };
    }

    if (typeof snapshot.unrealizedPct === 'number') {
      const takeProfitPct = config.takeProfitPct ?? DEFAULT_TAKE_PROFIT_PCT;
      const stopLossPct = config.stopLossPct ?? DEFAULT_STOP_LOSS_PCT;

      if (snapshot.unrealizedPct >= takeProfitPct) {
        return { action: 'dca-out', reason: 'take-profit' };
      }

      if (snapshot.unrealizedPct <= -stopLossPct) {
        return { action: 'dca-out', reason: 'stop-loss' };
      }
    }

    return { action: 'hold', reason: 'position-maintain' };
  }

  if (snapshot.lifecycleState === 'open') {
    return { action: 'hold', reason: 'lifecycle-open-without-inventory' };
  }

  if (!snapshot.inSession) {
    return { action: 'hold', reason: 'out-of-session' };
  }

  return { action: 'deploy', reason: 'criteria-met' };
}
