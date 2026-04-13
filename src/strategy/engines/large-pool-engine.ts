type LargePoolSnapshot = {
  score: number;
  feeTvlRatio?: number;
  fees24h?: number;
};

type LargePoolConfig = {
  minScore: number;
  minFeeTvlRatio?: number;
  minFees24h?: number;
};

export function buildLargePoolDecision(
  snapshot: LargePoolSnapshot,
  config: LargePoolConfig
): { action: 'deploy' | 'hold'; reason?: string } {
  if (snapshot.score < config.minScore) {
    return { action: 'hold', reason: 'score-below-minimum' };
  }

  if (typeof config.minFeeTvlRatio === 'number' && typeof snapshot.feeTvlRatio === 'number') {
    if (snapshot.feeTvlRatio < config.minFeeTvlRatio) {
      return { action: 'hold', reason: 'fee-tvl-ratio-below-minimum' };
    }
  }

  if (typeof config.minFees24h === 'number' && typeof snapshot.fees24h === 'number') {
    if (snapshot.fees24h < config.minFees24h) {
      return { action: 'hold', reason: 'fees24h-below-minimum' };
    }
  }

  return {
    action: 'deploy',
    reason: 'criteria-met'
  };
}
