export type SolExitQuote = {
  routeExists: boolean;
  outputSol: number;
  slippageBps: number;
  quotedAt: string;
  stale: boolean;
  /** Present only for execution-grade quote evidence, never fabricated by mechanical-soak. */
  action?: 'buy' | 'sell' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';
  poolAddress?: string;
  tokenMint?: string;
  requestedPositionSol?: number;
  chainPositionAddress?: string;
  quoteSlot?: number;
  impactBps?: number;
  estimatedTotalFeeLamports?: number;
  maxTotalFeeLamports?: number;
  lastValidBlockHeight?: number;
  expiresAt?: string;
  quoteHash?: string;
};

export type ExecutionPlan = {
  strategyId: string;
  poolAddress: string;
  exitMint: 'SOL';
  maxSlippageBps: number;
  maxImpactBps: number;
  solExitQuote: SolExitQuote;
};
