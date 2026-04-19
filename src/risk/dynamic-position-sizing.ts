type PositionBracket = {
  minTvlUsd: number;
  maxPositionSol: number;
};

export type PositionRiskContext = {
  safetyScore?: number;
  roundtripImpactBps?: number;
  proposalReadinessScore?: number;
};

const DEFAULT_BRACKETS: PositionBracket[] = [
  { minTvlUsd: 100_000, maxPositionSol: 0.15 },
  { minTvlUsd: 50_000, maxPositionSol: 0.10 },
  { minTvlUsd: 20_000, maxPositionSol: 0.08 },
  { minTvlUsd: 10_000, maxPositionSol: 0.05 },
  { minTvlUsd: 0, maxPositionSol: 0.02 }
];

export function computeDynamicPositionSol(
  liquidityUsd: number,
  requestedSol: number,
  brackets: PositionBracket[] = DEFAULT_BRACKETS,
  riskContext?: PositionRiskContext
): number {
  const sorted = [...brackets].sort(
    (left, right) => right.minTvlUsd - left.minTvlUsd
  );
  const match = sorted.find((bracket) => liquidityUsd >= bracket.minTvlUsd);
  const cap = match?.maxPositionSol ?? sorted[sorted.length - 1]?.maxPositionSol ?? requestedSol;
  const conservativeCap = roundPositionCap(cap * computePositionRiskMultiplier(riskContext));
  return Math.min(requestedSol, conservativeCap);
}

export function computePositionRiskMultiplier(riskContext?: PositionRiskContext) {
  if (!riskContext) {
    return 1;
  }

  let multiplier = 1;

  if (typeof riskContext.safetyScore === 'number') {
    if (riskContext.safetyScore < 70) {
      multiplier *= 0.7;
    } else if (riskContext.safetyScore < 85) {
      multiplier *= 0.85;
    }
  }

  if (typeof riskContext.roundtripImpactBps === 'number') {
    if (riskContext.roundtripImpactBps > 250) {
      multiplier *= 0.5;
    } else if (riskContext.roundtripImpactBps > 150) {
      multiplier *= 0.75;
    }
  }

  if (typeof riskContext.proposalReadinessScore === 'number') {
    if (riskContext.proposalReadinessScore < 0.4) {
      multiplier *= 0.66;
    } else if (riskContext.proposalReadinessScore < 0.55) {
      multiplier *= 0.8;
    }
  }

  return Math.min(1, roundPositionCap(multiplier));
}

function roundPositionCap(value: number) {
  return Math.round(value * 1000) / 1000;
}
