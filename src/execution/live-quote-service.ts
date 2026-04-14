import { quoteSolExit } from './sol-exit-quote.ts';
import type { SolExitQuote } from './types.ts';

export type CollectLiveQuoteInput = {
  expectedOutSol: number;
  slippageBps: number;
  routeExists: boolean;
};

export interface LiveQuoteProvider {
  collect(input: CollectLiveQuoteInput): Promise<SolExitQuote>;
}

export async function collectLiveQuote(
  input: CollectLiveQuoteInput
): Promise<SolExitQuote> {
  return quoteSolExit({
    expectedOutSol: input.expectedOutSol,
    slippageBps: input.slippageBps,
    routeExists: input.routeExists,
    stale: false
  });
}

export class StaticLiveQuoteProvider implements LiveQuoteProvider {
  async collect(input: CollectLiveQuoteInput): Promise<SolExitQuote> {
    return collectLiveQuote(input);
  }
}
