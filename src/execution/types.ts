export type SolExitQuote = {
  routeExists: boolean;
  outputSol: number;
  slippageBps: number;
  quotedAt: string;
  stale: boolean;
};

export type ExecutionPlan = {
  strategyId: string;
  poolAddress: string;
  exitMint: 'SOL';
  maxSlippageBps: number;
  maxImpactBps: number;
  solExitQuote: SolExitQuote;
};
