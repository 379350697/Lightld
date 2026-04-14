export type BuildOrderIntentInput = {
  strategyId: string;
  poolAddress: string;
  outputSol: number;
  createdAt?: string;
  side?: 'buy' | 'sell' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';
  tokenMint?: string;
  fullPositionExit?: boolean;
};

export function buildOrderIntent(input: BuildOrderIntentInput) {
  const createdAt = input.createdAt ?? new Date().toISOString();

  return {
    strategyId: input.strategyId,
    poolAddress: input.poolAddress,
    outputSol: input.outputSol,
    createdAt,
    idempotencyKey: `${input.strategyId}:${input.poolAddress}:${createdAt}`,
    side: input.side ?? 'buy',
    tokenMint: input.tokenMint ?? '',
    fullPositionExit: input.fullPositionExit ?? false
  };
}

