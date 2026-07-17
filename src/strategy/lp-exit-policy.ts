export type LpExitSnapshot = {
  hasLpPosition?: boolean;
  lpRiskIntent?: 'hold' | 'range-warning' | 'range-exit' | 'liquidity-exit' | 'volatility-exit';
  lpRiskReason?: string;
  lpNetPnlPct?: number;
  /** Paper-only active-bin model. It is never an executable exit quote or realized PnL. */
  lpModeledNetPnlPct?: number;
  /** Explicit evidence label required before a modeled value may drive paper TP/SL. */
  lpModeledPnlSource?: 'paper-shadow-dlmm-active-bin-modeled';
  lpUnclaimedFeeUsd?: number;
  lpSolDepletedBins?: number;
  lpSolExposureStatus?: 'sol-heavy' | 'mixed' | 'token-heavy' | 'sol-depleted';
  lpActiveBinStatus?: 'in-range' | 'out-of-range';
  lpImpermanentLossPct?: number;
  valuationStatus?: 'ready' | 'unavailable' | 'stale' | 'invalid';
  holdTimeMs?: number;
  pendingConfirmationStatus?: 'submitted' | 'confirmed' | 'failed' | 'unknown';
};

export type LpExitPolicyConfig = {
  maxHoldHours?: number;
  lpStopLossNetPnlPct?: number;
  lpTakeProfitNetPnlPct?: number;
  lpMinHoldMinutesBeforeTakeProfit?: number;
  lpSolDepletionExitBins?: number;
  lpClaimFeeThresholdUsd?: number;
  lpRebalanceOnOutOfRange?: boolean;
  lpMaxImpermanentLossPct?: number;
};

export type LpExitPolicyDecision = {
  action: 'withdraw-lp' | 'claim-fee' | 'rebalance-lp' | 'hold';
  reason: string;
};

export function buildLpExitPolicyDecision(
  snapshot: LpExitSnapshot,
  config: LpExitPolicyConfig = {}
): LpExitPolicyDecision {
  if (!snapshot.hasLpPosition) {
    return { action: 'hold', reason: 'lp-position-missing' };
  }

  if (snapshot.lpRiskIntent === 'range-exit') {
    return { action: 'withdraw-lp', reason: `lp-range-exit:${snapshot.lpRiskReason ?? 'range-risk'}` };
  }

  if (snapshot.lpRiskIntent === 'liquidity-exit') {
    return { action: 'withdraw-lp', reason: `lp-liquidity-exit:${snapshot.lpRiskReason ?? 'liquidity-risk'}` };
  }

  if (snapshot.lpRiskIntent === 'volatility-exit') {
    return { action: 'withdraw-lp', reason: `lp-volatility-exit:${snapshot.lpRiskReason ?? 'volatility-risk'}` };
  }

  const maxHoldMs = (config.maxHoldHours ?? 18) * 60 * 60 * 1000;
  if (typeof snapshot.holdTimeMs === 'number' && snapshot.holdTimeMs >= maxHoldMs) {
    return { action: 'withdraw-lp', reason: 'max-hold-with-lp-position' };
  }

  const pnlValuationReady = !snapshot.valuationStatus || snapshot.valuationStatus === 'ready';
  const effectivePnlPct = typeof snapshot.lpNetPnlPct === 'number'
    ? snapshot.lpNetPnlPct
    : snapshot.lpModeledPnlSource === 'paper-shadow-dlmm-active-bin-modeled'
      && typeof snapshot.lpModeledNetPnlPct === 'number'
      ? snapshot.lpModeledNetPnlPct
      : undefined;
  if (pnlValuationReady && typeof effectivePnlPct === 'number') {
    const stopLoss = config.lpStopLossNetPnlPct ?? 20;
    const takeProfit = config.lpTakeProfitNetPnlPct ?? 30;
    const minHoldMsBeforeTakeProfit = (config.lpMinHoldMinutesBeforeTakeProfit ?? 5) * 60 * 1000;
    const canTakeProfit = snapshot.pendingConfirmationStatus === 'confirmed'
      && typeof snapshot.holdTimeMs === 'number'
      && snapshot.holdTimeMs >= minHoldMsBeforeTakeProfit;

    if (effectivePnlPct <= -stopLoss) {
      return { action: 'withdraw-lp', reason: 'lp-stop-loss' };
    }

    if (effectivePnlPct >= takeProfit && canTakeProfit) {
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

  if (snapshot.lpSolExposureStatus === 'sol-depleted') {
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
