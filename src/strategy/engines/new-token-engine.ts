type NewTokenSnapshot = {
  inSession: boolean;
  hasInventory: boolean;
  score: number;
  unrealizedPct?: number;
  /** LP mode: whether an LP position already exists */
  hasLpPosition?: boolean;
  /** LP mode: net PnL percentage (fees + principal change) */
  lpNetPnlPct?: number;
  /** LP mode: unclimed fees in USD */
  lpUnclaimedFeeUsd?: number;
  /** LP mode: whether current price is within the position's bin range */
  lpActiveBinStatus?: 'in-range' | 'out-of-range';
  /** LP mode: impermanent loss percentage (positive number means loss) */
  lpImpermanentLossPct?: number;
  /** Explicit state machine for exits */
  lifecycleState?: string;
  /** Time elapsed in ms since the first buy fill */
  holdTimeMs?: number;
};

type NewTokenConfig = {
  minDeployScore: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  /** Enable LP mode (bid-ask single-sided SOL) */
  lpEnabled?: boolean;
  /** LP stop-loss threshold (net PnL %) */
  lpStopLossNetPnlPct?: number;
  /** LP take-profit threshold (net PnL %) */
  lpTakeProfitNetPnlPct?: number;
  /** LP claim fee threshold in USD */
  lpClaimFeeThresholdUsd?: number;
  /** LP whether to rebalance if out of range */
  lpRebalanceOnOutOfRange?: boolean;
  /** LP max impermanent loss percentage (positive number) */
  lpMaxImpermanentLossPct?: number;
};

export type NewTokenAction = 'deploy' | 'dca-out' | 'add-lp' | 'withdraw-lp' | 'hold' | 'claim-fee' | 'rebalance-lp';

export function buildNewTokenDecision(
  snapshot: NewTokenSnapshot,
  config: NewTokenConfig = { minDeployScore: 70 }
): { action: NewTokenAction; reason?: string } {
  if (!snapshot.inSession) {
    return { action: 'hold', reason: 'out-of-session' };
  }

  // ===== Explicit Exit State Machine =====
  if (snapshot.lifecycleState === 'inventory_exit_ready') {
    return { action: 'dca-out', reason: 'inventory-exit-ready' };
  }

  // ===== 18-Hour Force Exit =====
  const maxHoldMs = 18 * 60 * 60 * 1000;
  if (typeof snapshot.holdTimeMs === 'number' && snapshot.holdTimeMs >= maxHoldMs) {
    if (snapshot.hasLpPosition) {
      return { action: 'withdraw-lp', reason: 'max-hold-with-lp-position' };
    }
    if (snapshot.hasInventory) {
      return { action: 'dca-out', reason: 'max-hold-with-inventory' };
    }
  }

  // ===== LP mode (bid-ask single-sided SOL) =====
  if (config.lpEnabled) {
    if (snapshot.hasLpPosition) {
      if (typeof snapshot.lpNetPnlPct === 'number') {
        const stopLoss = config.lpStopLossNetPnlPct ?? 20;
        const takeProfit = config.lpTakeProfitNetPnlPct ?? 30;

        if (snapshot.lpNetPnlPct <= -stopLoss) {
          return { action: 'withdraw-lp', reason: 'lp-stop-loss' };
        }

        if (snapshot.lpNetPnlPct >= takeProfit) {
          return { action: 'withdraw-lp', reason: 'lp-take-profit' };
        }
      }

      if (
        typeof config.lpMaxImpermanentLossPct === 'number' &&
        typeof snapshot.lpImpermanentLossPct === 'number' &&
        snapshot.lpImpermanentLossPct >= config.lpMaxImpermanentLossPct
      ) {
        return { action: 'withdraw-lp', reason: 'lp-max-impermanent-loss' };
      }

      if (
        typeof config.lpClaimFeeThresholdUsd === 'number' &&
        typeof snapshot.lpUnclaimedFeeUsd === 'number' &&
        snapshot.lpUnclaimedFeeUsd >= config.lpClaimFeeThresholdUsd
      ) {
        return { action: 'claim-fee', reason: 'lp-claim-fee-threshold' };
      }

      if (config.lpRebalanceOnOutOfRange && snapshot.lpActiveBinStatus === 'out-of-range') {
        return { action: 'rebalance-lp', reason: 'lp-out-of-range' };
      }

      return { action: 'hold', reason: 'lp-position-maintain' };
    }

    // No LP position, open directly. Safety/LP filters already gated candidate quality upstream.
    return { action: 'add-lp', reason: 'lp-open-approved' };
  }

  // ===== Original swap mode (unchanged) =====
  if (snapshot.hasInventory) {
    if (typeof snapshot.unrealizedPct === 'number') {
      const takeProfit = config.takeProfitPct ?? 50;
      const stopLoss = config.stopLossPct ?? 20;

      if (snapshot.unrealizedPct >= takeProfit || snapshot.unrealizedPct <= -stopLoss) {
        return { action: 'dca-out', reason: 'spot-tp-or-sl' };
      }

      return { action: 'hold', reason: 'spot-position-maintain' };
    }

    return { action: 'dca-out', reason: 'spot-has-inventory-no-pnl' };
  }

  return { action: 'deploy', reason: 'spot-open-approved' };
}
