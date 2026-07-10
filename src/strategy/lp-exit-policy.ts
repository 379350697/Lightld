export type LpExitSnapshot = {
  hasLpPosition?: boolean;
  lpRiskIntent?: 'hold' | 'range-warning' | 'range-exit' | 'liquidity-exit' | 'volatility-exit';
  lpRiskReason?: string;
  lpNetPnlPct?: number;
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
  reasons?: string[];
  secondaryReason?: string;
};

export function buildLpExitPolicyDecision(
  snapshot: LpExitSnapshot,
  config: LpExitPolicyConfig = {}
): LpExitPolicyDecision {
  if (!snapshot.hasLpPosition) {
    return { action: 'hold', reason: 'lp-position-missing' };
  }

  const withdrawReasons: string[] = [];
  const addWithdrawReason = (reason: string) => {
    if (!withdrawReasons.includes(reason)) {
      withdrawReasons.push(reason);
    }
  };

  const rangeRiskReason = snapshot.lpRiskIntent === 'range-exit'
    ? `lp-range-exit:${snapshot.lpRiskReason ?? 'range-risk'}`
    : snapshot.lpRiskIntent === 'liquidity-exit'
      ? `lp-liquidity-exit:${snapshot.lpRiskReason ?? 'liquidity-risk'}`
      : snapshot.lpRiskIntent === 'volatility-exit'
        ? `lp-volatility-exit:${snapshot.lpRiskReason ?? 'volatility-risk'}`
        : undefined;

  const solDepletionReason = (
    typeof config.lpSolDepletionExitBins === 'number' &&
    typeof snapshot.lpSolDepletedBins === 'number' &&
    snapshot.lpSolDepletedBins >= config.lpSolDepletionExitBins
  ) || snapshot.lpSolExposureStatus === 'sol-depleted'
    ? 'lp-sol-nearly-depleted'
    : undefined;

  const maxHoldMs = (config.maxHoldHours ?? 18) * 60 * 60 * 1000;
  const maxHoldReason = typeof snapshot.holdTimeMs === 'number' && snapshot.holdTimeMs >= maxHoldMs
    ? 'max-hold-with-lp-position'
    : undefined;

  const pnlValuationReady = !snapshot.valuationStatus || snapshot.valuationStatus === 'ready';
  if (pnlValuationReady && typeof snapshot.lpNetPnlPct === 'number') {
    const stopLoss = config.lpStopLossNetPnlPct ?? 20;
    const takeProfit = config.lpTakeProfitNetPnlPct ?? 30;
    const minHoldMsBeforeTakeProfit = (config.lpMinHoldMinutesBeforeTakeProfit ?? 5) * 60 * 1000;
    const canTakeProfit = snapshot.pendingConfirmationStatus === 'confirmed'
      && typeof snapshot.holdTimeMs === 'number'
      && snapshot.holdTimeMs >= minHoldMsBeforeTakeProfit;

    if (snapshot.lpNetPnlPct <= -stopLoss) {
      addWithdrawReason('lp-stop-loss');
    }

    if (snapshot.lpNetPnlPct >= takeProfit && canTakeProfit) {
      addWithdrawReason('lp-take-profit');
    }
  }

  if (rangeRiskReason) {
    addWithdrawReason(rangeRiskReason);
  }

  if (
    typeof config.lpMaxImpermanentLossPct === 'number' &&
    typeof snapshot.lpImpermanentLossPct === 'number' &&
    snapshot.lpImpermanentLossPct >= config.lpMaxImpermanentLossPct
  ) {
    addWithdrawReason('lp-max-impermanent-loss');
  }

  if (solDepletionReason) {
    addWithdrawReason(solDepletionReason);
  }

  if (maxHoldReason) {
    addWithdrawReason(maxHoldReason);
  }

  if (withdrawReasons.length > 0) {
    return {
      action: 'withdraw-lp',
      reason: withdrawReasons[0],
      reasons: withdrawReasons,
      secondaryReason: withdrawReasons[1]
    };
  }

  if (
    typeof config.lpClaimFeeThresholdUsd === 'number' &&
    typeof snapshot.lpUnclaimedFeeUsd === 'number' &&
    snapshot.lpUnclaimedFeeUsd >= config.lpClaimFeeThresholdUsd
  ) {
    return { action: 'claim-fee', reason: 'lp-claim-fee-threshold', reasons: ['lp-claim-fee-threshold'] };
  }

  if (config.lpRebalanceOnOutOfRange && snapshot.lpActiveBinStatus === 'out-of-range') {
    return { action: 'rebalance-lp', reason: 'lp-out-of-range', reasons: ['lp-out-of-range'] };
  }

  return { action: 'hold', reason: 'lp-position-maintain', reasons: ['lp-position-maintain'] };
}
