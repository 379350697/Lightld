type LargePoolSnapshot = {
  score: number;
};

type LargePoolConfig = {
  minScore: number;
};

export function buildLargePoolDecision(
  snapshot: LargePoolSnapshot,
  config: LargePoolConfig
): { action: 'deploy' | 'hold' } {
  return {
    action: snapshot.score >= config.minScore ? 'deploy' : 'hold'
  };
}
