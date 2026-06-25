export type LpExitSnapshot = {
  hasLpPosition?: boolean;
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
};

export function buildLpExitPolicyDecision(
  snapshot: LpExitSnapshot,
  config: LpExitPolicyConfig = {}
): LpExitPolicyDecision {
  if (!snapshot.hasLpPosition) {
    return { action: 'hold', reason: 'lp-position-missing' };
  }

  const maxHoldMs = (config.maxHoldHours ?? 18) * 60 * 60 * 1000;
  if (typeof snapshot.holdTimeMs === 'number' && snapshot.holdTimeMs >= maxHoldMs) {
    return { action: 'withdraw-lp', reason: 'max-hold-with-lp-position' };
  }

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
