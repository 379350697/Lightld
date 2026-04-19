type NewTokenSnapshot = {
  inSession: boolean;
  hasInventory: boolean;
  unrealizedPct?: number;
  /** LP mode: whether an LP position already exists */
  hasLpPosition?: boolean;
  /** LP mode: net PnL percentage (fees + principal change) */
  lpNetPnlPct?: number;
  /** LP mode: current LP value measured in SOL */
  lpCurrentValueSol?: number;
  /** LP mode: unclaimed fee value measured in SOL */
  lpUnclaimedFeeSol?: number;
  /** LP mode: how many bins the SOL side has already been consumed across */
  lpSolDepletedBins?: number;
  /** LP mode: unclimed fees in USD */
  lpUnclaimedFeeUsd?: number;
  /** LP mode: whether current price is within the position's bin range */
  lpActiveBinStatus?: 'in-range' | 'out-of-range';
  /** LP mode: impermanent loss percentage (positive number means loss) */
  lpImpermanentLossPct?: number;
  /** LP mode: whether the valuation inputs are safe enough for PnL exits */
  valuationStatus?: 'ready' | 'unavailable' | 'stale' | 'invalid';
  /** LP mode: why valuation is not ready */
  valuationReason?: string;
  /** Explicit state machine for exits */
  lifecycleState?: string;
  /** Time elapsed in ms since the first buy fill */
  holdTimeMs?: number;
  /** Pending submission confirmation status for this mint/pool */
  pendingConfirmationStatus?: 'submitted' | 'confirmed' | 'failed' | 'unknown';
};

type NewTokenConfig = {
  takeProfitPct?: number;
  stopLossPct?: number;
  maxHoldHours?: number;
  /** Enable LP mode (bid-ask single-sided SOL) */
  lpEnabled?: boolean;
  /** LP stop-loss threshold (net PnL %) */
  lpStopLossNetPnlPct?: number;
  /** LP take-profit threshold (net PnL %) */
  lpTakeProfitNetPnlPct?: number;
  /** Minimum LP hold minutes before allowing take-profit */
  lpMinHoldMinutesBeforeTakeProfit?: number;
  /** LP hard exit threshold when the SOL side is nearly exhausted */
  lpSolDepletionExitBins?: number;
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
  config: NewTokenConfig = {}
): { action: NewTokenAction; reason?: string } {
  if (!snapshot.inSession) {
    return { action: 'hold', reason: 'out-of-session' };
  }

  // ===== Explicit Exit State Machine =====
  if (snapshot.lifecycleState === 'inventory_exit_ready') {
    return { action: 'dca-out', reason: 'inventory-exit-ready' };
  }

  // ===== 18-Hour Force Exit =====
  const maxHoldMs = (config.maxHoldHours ?? 18) * 60 * 60 * 1000;
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
      const pnlValuationReady = !snapshot.valuationStatus || snapshot.valuationStatus === 'ready';

      if (pnlValuationReady && typeof snapshot.lpNetPnlPct === 'number') {
        const stopLoss = config.lpStopLossNetPnlPct ?? 20;
        const takeProfit = config.lpTakeProfitNetPnlPct ?? 30;
        const minHoldMsBeforeTakeProfit = (config.lpMinHoldMinutesBeforeTakeProfit ?? 5) * 60 * 1000;
        const canTakeProfit = snapshot.pendingConfirmationStatus === 'confirmed'
          && typeof snapshot.holdTimeMs === 'number'
          && snapshot.holdTimeMs >= minHoldMsBeforeTakeProfit;

        if (snapshot.lpNetPnlPct <= -stopLoss) {
          return { action: 'withdraw-lp', reason: 'lp-stop-loss' };
        }

        if (snapshot.lpNetPnlPct >= takeProfit && canTakeProfit) {
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
        typeof config.lpSolDepletionExitBins === 'number' &&
        typeof snapshot.lpSolDepletedBins === 'number' &&
        snapshot.lpSolDepletedBins >= config.lpSolDepletionExitBins
      ) {
        return { action: 'withdraw-lp', reason: 'lp-sol-nearly-depleted' };
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

    // LP opens are gated upstream by LP pool eligibility checks. Once a candidate
    // reaches this stage without an existing LP position, open the LP directly.
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
