type LargePoolSnapshot = {
  score: number;
};

type LargePoolConfig = {
  minScore: number;
};

export function buildLargePoolDecision(
  snapshot: LargePoolSnapshot,
  config: LargePoolConfig
): { action: 'deploy' | 'hold'; reason?: string } {
  if (snapshot.score < config.minScore) {
    return { action: 'hold', reason: 'score-below-minimum' };
  }

  return {
    action: 'deploy',
    reason: 'criteria-met'
  };
}
