type ScoreInputs = {
  holders: number;
  liquidity: number;
  momentum: number;
};

type ScoreWeights = {
  holders: number;
  liquidity: number;
  momentum: number;
};

export function computeWeightedScore(inputs: ScoreInputs, weights: ScoreWeights) {
  return (
    inputs.holders * weights.holders +
    inputs.liquidity * weights.liquidity +
    inputs.momentum * weights.momentum
  );
}
