export type LpPnlConfig = {
  stopLossNetPnlPct: number;
  takeProfitNetPnlPct: number;
};

export type LpPnlCheckResult = {
  action: 'force-sell' | 'hold';
  reason: string;
  unrealizedPct: number;
};

export function evaluateLpPnl(
  entrySol: number,
  currentValueSol: number,
  accumulatedFeesSol: number,
  config: LpPnlConfig
): LpPnlCheckResult {
  if (entrySol <= 0) {
    return { action: 'hold', reason: 'no-entry-value', unrealizedPct: 0 };
  }

  const netPnlPct =
    ((currentValueSol + accumulatedFeesSol - entrySol) / entrySol) * 100;

  if (netPnlPct <= -config.stopLossNetPnlPct) {
    return {
      action: 'force-sell',
      reason: `lp-stop-loss (${netPnlPct.toFixed(1)}%)`,
      unrealizedPct: netPnlPct
    };
  }

  if (netPnlPct >= config.takeProfitNetPnlPct) {
    return {
      action: 'force-sell',
      reason: `lp-take-profit (${netPnlPct.toFixed(1)}%)`,
      unrealizedPct: netPnlPct
    };
  }

  return { action: 'hold', reason: 'within-lp-thresholds', unrealizedPct: netPnlPct };
}
