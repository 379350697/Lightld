import { quoteSolExit } from './sol-exit-quote.ts';
import type { ExecutionPlan, SolExitQuote } from './types.ts';

type BuildExecutionPlanInput = {
  strategyId: string;
  targetPool: string;
  quote?: SolExitQuote;
};

export function buildExecutionPlan(input: BuildExecutionPlanInput): ExecutionPlan {
  return {
    strategyId: input.strategyId,
    poolAddress: input.targetPool,
    exitMint: 'SOL',
    maxSlippageBps: 100,
    maxImpactBps: 200,
    solExitQuote:
      input.quote ??
      quoteSolExit({
        expectedOutSol: 0,
        slippageBps: 100,
        routeExists: true,
        stale: false
      })
  };
}
