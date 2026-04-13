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
): { action: NewTokenAction } {
  if (!snapshot.inSession) {
    return { action: 'hold' };
  }

  // ===== LP mode (bid-ask single-sided SOL) =====
  if (config.lpEnabled) {
    if (snapshot.hasLpPosition) {
      if (typeof snapshot.lpNetPnlPct === 'number') {
        const stopLoss = config.lpStopLossNetPnlPct ?? 20;
        const takeProfit = config.lpTakeProfitNetPnlPct ?? 30;

        if (snapshot.lpNetPnlPct <= -stopLoss) {
          return { action: 'withdraw-lp' };
        }

        if (snapshot.lpNetPnlPct >= takeProfit) {
          return { action: 'withdraw-lp' };
        }
      }

      if (typeof config.lpMaxImpermanentLossPct === 'number' && 
          typeof snapshot.lpImpermanentLossPct === 'number' && 
          snapshot.lpImpermanentLossPct >= config.lpMaxImpermanentLossPct) {
        return { action: 'withdraw-lp' };
      }

      if (typeof config.lpClaimFeeThresholdUsd === 'number' && 
          typeof snapshot.lpUnclaimedFeeUsd === 'number' && 
          snapshot.lpUnclaimedFeeUsd >= config.lpClaimFeeThresholdUsd) {
        return { action: 'claim-fee' };
      }

      if (config.lpRebalanceOnOutOfRange && snapshot.lpActiveBinStatus === 'out-of-range') {
        return { action: 'rebalance-lp' };
      }

      return { action: 'hold' };
    }

    // No LP position — check score to open one
    if (snapshot.score >= config.minDeployScore) {
      return { action: 'add-lp' };
    }

    return { action: 'hold' };
  }

  // ===== Original swap mode (unchanged) =====
  if (snapshot.hasInventory) {
    if (typeof snapshot.unrealizedPct === 'number') {
      const takeProfit = config.takeProfitPct ?? 50;
      const stopLoss = config.stopLossPct ?? 20;
      
      if (snapshot.unrealizedPct >= takeProfit || snapshot.unrealizedPct <= -stopLoss) {
        return { action: 'dca-out' };
      }
      
      return { action: 'hold' };
    }
    
    return { action: 'dca-out' };
  }

  if (snapshot.score >= config.minDeployScore) {
    return { action: 'deploy' };
  }

  return { action: 'hold' };
}

