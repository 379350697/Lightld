import type { TokenSafetyResult } from '../ingest/gmgn/token-safety-client.ts';
import { GMGN_SAFETY_DEFERRED_ERROR, isTokenSafe } from '../ingest/gmgn/token-safety-client.ts';
import type { IngestCandidate } from '../runtime/ingest-candidate-selection.ts';
import type { StrategyId } from '../runtime/live-cycle.ts';
import type { CandidateSourceObservation } from './types.ts';

function expiresAt(now: Date, ttlMs: number) {
  return new Date(now.getTime() + Math.max(0, ttlMs)).toISOString();
}

function boundedPositive(value: number, cap: number) {
  return Number.isFinite(value) && value > 0 ? Math.min(cap, value) : 0;
}

function feeTvlScore(feeTvlRatio24h: number) {
  if (!Number.isFinite(feeTvlRatio24h) || feeTvlRatio24h <= 0) return 0;

  // Meteora rows can surface this as a decimal ratio or a percent-like number.
  const percentLikeValue = feeTvlRatio24h <= 1 ? feeTvlRatio24h * 100 : feeTvlRatio24h;
  return Math.min(50, percentLikeValue);
}

function candidateScore(candidate: IngestCandidate) {
  return feeTvlScore(candidate.feeTvlRatio24h)
    + boundedPositive(candidate.volume24h / 100_000, 25)
    + boundedPositive(candidate.liquidityUsd / 10_000, 25);
}

export function buildMeteoraObservation(input: {
  strategyId: StrategyId;
  candidate: IngestCandidate;
  now: Date;
  ttlMs: number;
  latencyMs?: number;
}): CandidateSourceObservation {
  return {
    strategyId: input.strategyId,
    poolAddress: input.candidate.address,
    tokenMint: input.candidate.mint,
    source: 'meteora',
    status: 'passed',
    observedAt: input.now.toISOString(),
    expiresAt: expiresAt(input.now, input.ttlMs),
    latencyMs: input.latencyMs ?? 0,
    score: candidateScore(input.candidate),
    hardRejectReason: '',
    rawJson: {
      liquidityUsd: input.candidate.liquidityUsd,
      volume24h: input.candidate.volume24h,
      feeTvlRatio24h: input.candidate.feeTvlRatio24h,
      binStep: input.candidate.binStep,
      baseFeePct: input.candidate.baseFeePct
    }
  };
}

export function buildRouteObservation(input: {
  strategyId: StrategyId;
  candidate: IngestCandidate;
  now: Date;
  ttlMs: number;
  latencyMs?: number;
  routeExists: boolean;
  hardRejectReason?: string;
  rawJson?: Record<string, unknown>;
}): CandidateSourceObservation {
  const routeExists = input.routeExists;
  return {
    strategyId: input.strategyId,
    poolAddress: input.candidate.address,
    tokenMint: input.candidate.mint,
    source: 'jupiter_route',
    status: routeExists ? 'passed' : 'blocked',
    observedAt: input.now.toISOString(),
    expiresAt: expiresAt(input.now, input.ttlMs),
    latencyMs: input.latencyMs ?? 0,
    score: routeExists ? 10 : 0,
    hardRejectReason: routeExists ? '' : (input.hardRejectReason ?? 'no-sol-route'),
    rawJson: input.rawJson ?? {
      hasSolRoute: input.candidate.hasSolRoute,
      quoteMint: input.candidate.quoteMint
    }
  };
}

export function buildFailedRouteObservation(input: {
  strategyId: StrategyId;
  candidate: IngestCandidate;
  now: Date;
  ttlMs: number;
  latencyMs: number;
  reason: string;
}): CandidateSourceObservation {
  return {
    strategyId: input.strategyId,
    poolAddress: input.candidate.address,
    tokenMint: input.candidate.mint,
    source: 'jupiter_route',
    status: 'failed',
    observedAt: input.now.toISOString(),
    expiresAt: expiresAt(input.now, input.ttlMs),
    latencyMs: input.latencyMs,
    score: 0,
    hardRejectReason: 'jupiter-route-check-failed',
    rawJson: {
      error: input.reason,
      quoteMint: input.candidate.quoteMint
    }
  };
}

export function buildGmgnObservation(input: {
  strategyId: StrategyId;
  candidate: IngestCandidate;
  now: Date;
  ttlMs: number;
  latencyMs: number;
  result: TokenSafetyResult | undefined;
}): CandidateSourceObservation {
  const result = input.result;
  const hasError = Boolean(result?.error);
  const deferred = result?.error === GMGN_SAFETY_DEFERRED_ERROR;
  const safe = result ? isTokenSafe(result, { disabled: false, minHolders: 0, minBluechipPct: 0, minSafetyScore: 0 }) : false;
  const hardRejectReason = !hasError && result && !safe
    ? (result.rejectReasons?.join(',') || 'gmgn-unsafe')
    : '';

  return {
    strategyId: input.strategyId,
    poolAddress: input.candidate.address,
    tokenMint: input.candidate.mint,
    source: 'gmgn',
    status: !result
      ? 'deferred'
      : deferred
        ? 'deferred'
        : hasError
          ? 'failed'
          : safe
            ? 'passed'
            : 'blocked',
    observedAt: input.now.toISOString(),
    expiresAt: expiresAt(input.now, input.ttlMs),
    latencyMs: input.latencyMs,
    score: safe ? Math.max(0, result?.safetyScore ?? 0) : 0,
    hardRejectReason,
    rawJson: result ? { ...result } : { error: 'gmgn-not-checked-this-cycle' }
  };
}
