export type BuildOrderIntentInput = {
  strategyId: string;
  poolAddress: string;
  outputSol: number;
  createdAt?: string;
};

export function buildOrderIntent(input: BuildOrderIntentInput) {
  const createdAt = input.createdAt ?? new Date().toISOString();

  return {
    strategyId: input.strategyId,
    poolAddress: input.poolAddress,
    outputSol: input.outputSol,
    createdAt,
    idempotencyKey: `${input.strategyId}:${input.poolAddress}:${createdAt}`
  };
}
