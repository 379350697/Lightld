type GateSnapshot = {
  hasSolRoute?: boolean;
  liquidityUsd?: number;
};

type GateConfig = {
  requireSolRoute?: boolean;
  minLiquidityUsd?: number;
};

export function evaluateHardGates(snapshot: GateSnapshot, config: GateConfig) {
  const reasons: string[] = [];

  if (config.requireSolRoute && !snapshot.hasSolRoute) {
    reasons.push('missing-sol-route');
  }

  if (
    typeof config.minLiquidityUsd === 'number' &&
    (snapshot.liquidityUsd ?? 0) < config.minLiquidityUsd
  ) {
    reasons.push('insufficient-liquidity');
  }

  return {
    accepted: reasons.length === 0,
    reasons
  };
}
