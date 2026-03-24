import type { SolExitQuote } from './types.ts';

type QuoteInput = {
  expectedOutSol: number;
  slippageBps: number;
  routeExists: boolean;
  quotedAt?: string;
  stale?: boolean;
};

export function quoteSolExit(input: QuoteInput): SolExitQuote {
  return {
    routeExists: input.routeExists,
    outputSol: input.expectedOutSol,
    slippageBps: input.slippageBps,
    quotedAt: input.quotedAt ?? new Date().toISOString(),
    stale: input.stale ?? false
  };
}
