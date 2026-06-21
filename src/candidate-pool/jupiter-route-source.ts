import {
  JupiterClient,
  type JupiterQuoteResponse
} from '../execution/solana/jupiter-client.ts';
import type { CandidateSourceAdapter } from './types.ts';
import {
  buildFailedRouteObservation,
  buildRouteObservation
} from './source-observations.ts';

function routePlanLength(quote: JupiterQuoteResponse) {
  return Array.isArray(quote.routePlan) ? quote.routePlan.length : 0;
}

function hasPositiveOutAmount(quote: JupiterQuoteResponse) {
  try {
    return BigInt(quote.outAmount) > 0n;
  } catch {
    return false;
  }
}

function routeExists(quote: JupiterQuoteResponse) {
  return routePlanLength(quote) > 0 && hasPositiveOutAmount(quote);
}

export function createJupiterRouteSource(options: {
  client?: JupiterClient;
  quoteSol: number;
  slippageBps: number;
  ttlMs: number;
}): CandidateSourceAdapter {
  const client = options.client ?? new JupiterClient();

  return {
    source: 'jupiter_route',
    async observe(candidate, context) {
      const startedAt = Date.now();

      try {
        const quote = await client.getQuote(
          client.buildBuyQuoteParams(candidate.mint, options.quoteSol, options.slippageBps)
        );
        const exists = routeExists(quote);
        return buildRouteObservation({
          strategyId: context.strategyId,
          candidate,
          now: context.now,
          ttlMs: options.ttlMs,
          latencyMs: Date.now() - startedAt,
          routeExists: exists,
          hardRejectReason: 'no-jupiter-sol-route',
          rawJson: {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inAmount: quote.inAmount,
            outAmount: quote.outAmount,
            priceImpactPct: quote.priceImpactPct,
            routePlanLength: routePlanLength(quote),
            slippageBps: quote.slippageBps
          }
        });
      } catch (error) {
        return buildFailedRouteObservation({
          strategyId: context.strategyId,
          candidate,
          now: context.now,
          ttlMs: options.ttlMs,
          latencyMs: Date.now() - startedAt,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };
}
