type GateSnapshot = {
  hasSolRoute?: boolean;
  liquidityUsd?: number;
  poolCreatedAt?: string;
};

type GateConfig = {
  requireSolRoute?: boolean;
  minLiquidityUsd?: number;
  minPoolAgeMinutes?: number;
  maxPoolAgeMinutes?: number;
  nowMs?: number;
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

  if (
    typeof config.minPoolAgeMinutes === 'number' &&
    snapshot.poolCreatedAt
  ) {
    const ageMs = (config.nowMs ?? Date.now()) - Date.parse(snapshot.poolCreatedAt);
    const ageMinutes = ageMs / 60_000;

    if (ageMinutes < config.minPoolAgeMinutes) {
      reasons.push('pool-too-young');
    }
  }

  if (
    typeof config.maxPoolAgeMinutes === 'number' &&
    snapshot.poolCreatedAt
  ) {
    const ageMs = (config.nowMs ?? Date.now()) - Date.parse(snapshot.poolCreatedAt);
    const ageMinutes = ageMs / 60_000;

    if (ageMinutes > config.maxPoolAgeMinutes) {
      reasons.push('pool-too-old');
    }
  }

  return {
    accepted: reasons.length === 0,
    reasons
  };
}

