type PositionBracket = {
  minTvlUsd: number;
  maxPositionSol: number;
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
  brackets: PositionBracket[] = DEFAULT_BRACKETS
): number {
  const sorted = [...brackets].sort(
    (left, right) => right.minTvlUsd - left.minTvlUsd
  );
  const match = sorted.find((bracket) => liquidityUsd >= bracket.minTvlUsd);
  const cap = match?.maxPositionSol ?? sorted[sorted.length - 1]?.maxPositionSol ?? requestedSol;
  return Math.min(requestedSol, cap);
}
