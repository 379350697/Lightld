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

function priceImpactBps(quote: JupiterQuoteResponse) {
  const impactPct = Number(quote.priceImpactPct);
  return Number.isFinite(impactPct) ? Math.abs(impactPct) * 100 : undefined;
}

function positiveNumber(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveCandidateRouteQuoteSol(
  env: Record<string, string | undefined> = process.env
) {
  const explicitQuoteSol = positiveNumber(env.LIVE_CANDIDATE_ROUTE_QUOTE_SOL);
  // Candidate admission must prove the route at the largest size the daemon
  // can actually request, rather than at a smaller demonstration quote. An
  // explicit probe can increase this size but cannot weaken that invariant.
  const maximumOrderSol = positiveNumber(env.LIVE_MAX_SINGLE_ORDER_SOL) ?? 0.05;
  return Math.max(maximumOrderSol, explicitQuoteSol ?? 0);
}

export function createJupiterRouteSource(options: {
  client?: JupiterClient;
  quoteSol: number;
  slippageBps: number;
  maxImpactBps: number;
  ttlMs: number;
}): CandidateSourceAdapter {
  const client = options.client ?? new JupiterClient();

  return {
    source: 'jupiter_route',
    async observe(candidate, context) {
      const startedAt = Date.now();

      try {
        const buyQuote = await client.getQuote(
          client.buildBuyQuoteParams(candidate.mint, options.quoteSol, options.slippageBps)
        );
        const hasBuyRoute = routeExists(buyQuote);
        const buyImpactBps = priceImpactBps(buyQuote);
        const buyImpactKnown = typeof buyImpactBps === 'number';
        const buyImpactWithinLimit = buyImpactKnown && buyImpactBps <= options.maxImpactBps;
        if (!hasBuyRoute || !buyImpactWithinLimit) {
          const hardRejectReason = !hasBuyRoute
          ? 'no-jupiter-sol-route'
          : !buyImpactKnown
            ? 'jupiter-price-impact-unavailable'
            : 'jupiter-price-impact-exceeds-limit';
          return buildRouteObservation({
            strategyId: context.strategyId,
            candidate,
            now: context.now,
            ttlMs: options.ttlMs,
            latencyMs: Date.now() - startedAt,
            routeExists: false,
            hardRejectReason,
            rawJson: {
              inputMint: buyQuote.inputMint,
              outputMint: buyQuote.outputMint,
              inAmount: buyQuote.inAmount,
              outAmount: buyQuote.outAmount,
              priceImpactPct: buyQuote.priceImpactPct,
              priceImpactBps: buyImpactBps,
              maxImpactBps: options.maxImpactBps,
              routePlanLength: routePlanLength(buyQuote),
              slippageBps: buyQuote.slippageBps,
              direction: 'entry'
            }
          });
        }

        // A buy route alone is not sufficient admission evidence.  The
        // position must also have an executable token -> SOL path at the same
        // economic size, otherwise paper/live can open an exposure that the
        // normal close path cannot liquidate.
        const exitQuote = await client.getQuote(
          client.buildSellQuoteParams(candidate.mint, buyQuote.outAmount, options.slippageBps)
        );
        const hasExitRoute = routeExists(exitQuote);
        const exitImpactBps = priceImpactBps(exitQuote);
        const exitImpactKnown = typeof exitImpactBps === 'number';
        const exitImpactWithinLimit = exitImpactKnown && exitImpactBps <= options.maxImpactBps;
        const routeIsRoundTripExecutable = hasExitRoute && exitImpactWithinLimit;
        const hardRejectReason = !hasExitRoute
          ? 'no-jupiter-exit-route'
          : !exitImpactKnown
            ? 'jupiter-exit-price-impact-unavailable'
            : 'jupiter-exit-price-impact-exceeds-limit';
        return buildRouteObservation({
          strategyId: context.strategyId,
          candidate,
          now: context.now,
          ttlMs: options.ttlMs,
          latencyMs: Date.now() - startedAt,
          routeExists: routeIsRoundTripExecutable,
          hardRejectReason,
          rawJson: {
            // Keep the original top-level fields for existing status readers.
            inputMint: buyQuote.inputMint,
            outputMint: buyQuote.outputMint,
            inAmount: buyQuote.inAmount,
            outAmount: buyQuote.outAmount,
            priceImpactPct: buyQuote.priceImpactPct,
            priceImpactBps: buyImpactBps,
            maxImpactBps: options.maxImpactBps,
            routePlanLength: routePlanLength(buyQuote),
            slippageBps: buyQuote.slippageBps,
            roundTripChecked: true,
            exitInputMint: exitQuote.inputMint,
            exitOutputMint: exitQuote.outputMint,
            exitInAmount: exitQuote.inAmount,
            exitOutAmount: exitQuote.outAmount,
            exitPriceImpactPct: exitQuote.priceImpactPct,
            exitPriceImpactBps: exitImpactBps,
            exitRoutePlanLength: routePlanLength(exitQuote),
            exitSlippageBps: exitQuote.slippageBps
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
