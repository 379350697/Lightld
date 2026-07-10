import type { IngestCandidate } from '../runtime/ingest-candidate-selection.ts';
import type { StrategyId } from '../runtime/live-cycle.ts';
import type {
  CandidatePoolEntry,
  CandidatePoolStatus,
  CandidateSourceName,
  CandidateSourceObservation
} from './types.ts';

const REQUIRED_MARKET_SOURCES: CandidateSourceName[] = ['meteora', 'jupiter_route'];
const SECURITY_SOURCES: CandidateSourceName[] = ['gmgn', 'chain_fast_safety'];
const GMGN_BLOCK_REASON_PREFIX = 'gmgn:';
const POOL_FEE_YIELD_BLOCK_REASON_PREFIX = 'pool_fee_yield:';

function parseTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maxIso(values: string[], fallback: string) {
  let maxMs = 0;
  for (const value of values) {
    maxMs = Math.max(maxMs, parseTime(value));
  }
  return maxMs > 0 ? new Date(maxMs).toISOString() : fallback;
}

function minIso(values: string[], fallback: string) {
  let minMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const parsed = parseTime(value);
    if (parsed > 0) {
      minMs = Math.min(minMs, parsed);
    }
  }
  return Number.isFinite(minMs) ? new Date(minMs).toISOString() : fallback;
}

export function feeTvlScore(candidate: Pick<IngestCandidate, 'feeTvlRatio24h' | 'poolFeeYieldStatus'>) {
  if (candidate.poolFeeYieldStatus && candidate.poolFeeYieldStatus !== 'yield_profile_missing') {
    return 0;
  }

  if (candidate.feeTvlRatio24h > 0.20) return 40;
  if (candidate.feeTvlRatio24h >= 0.10) return 30;
  if (candidate.feeTvlRatio24h >= 0.05) return 20;
  return 0;
}

function maxPassedObservationScore(
  observations: CandidateSourceObservation[],
  sources: CandidateSourceName[]
) {
  return observations
    .filter((observation) => observation.status === 'passed' && sources.includes(observation.source))
    .reduce((max, observation) => Math.max(max, observation.score), 0);
}

function resolveSecurityStatus(input: {
  observations: CandidateSourceObservation[];
  nowMs: number;
}) {
  const securityObservations = input.observations.filter((observation) =>
    SECURITY_SOURCES.includes(observation.source)
  );

  if (securityObservations.length === 0) {
    return {
      status: 'source_unavailable' as CandidatePoolStatus,
      blockReason: 'missing-security-source'
    };
  }

  for (const observation of securityObservations) {
    const fresh = parseTime(observation.expiresAt) > input.nowMs && observation.status !== 'stale';
    if (fresh && observation.status === 'blocked') {
      const prefix = observation.source === 'gmgn' ? GMGN_BLOCK_REASON_PREFIX : `${observation.source}:`;
      return {
        status: 'blocked' as CandidatePoolStatus,
        blockReason: observation.hardRejectReason
          ? `${prefix}${observation.hardRejectReason}`
          : `${observation.source}-blocked`
      };
    }
  }

  const freshPassed = securityObservations.some((observation) =>
    parseTime(observation.expiresAt) > input.nowMs
      && observation.status === 'passed'
  );
  if (freshPassed) {
    return null;
  }

  const hasOnlyStale = securityObservations.every((observation) =>
    parseTime(observation.expiresAt) <= input.nowMs || observation.status === 'stale'
  );
  if (hasOnlyStale) {
    return {
      status: 'stale' as CandidatePoolStatus,
      blockReason: `stale-${securityObservations[0]?.source ?? 'security-source'}`
    };
  }

  const unavailable = securityObservations.find((observation) => observation.status !== 'passed')
    ?? securityObservations[0];
  return {
    status: 'source_unavailable' as CandidatePoolStatus,
    blockReason: `${unavailable?.source ?? 'security-source'}-${unavailable?.status ?? 'missing'}`
  };
}

function resolveStatus(input: {
  candidate: IngestCandidate;
  observations: CandidateSourceObservation[];
  now: Date;
}) {
  const nowMs = input.now.getTime();
  const bySource = new Map(input.observations.map((observation) => [observation.source, observation] as const));

  const meteora = bySource.get('meteora');
  if (!meteora) {
    return {
      status: 'observed' as CandidatePoolStatus,
      blockReason: 'missing-meteora'
    };
  }

  if (parseTime(meteora.expiresAt) <= nowMs || meteora.status === 'stale') {
    return {
      status: 'stale' as CandidatePoolStatus,
      blockReason: 'stale-meteora'
    };
  }

  if (meteora.status === 'blocked') {
    return {
      status: 'blocked' as CandidatePoolStatus,
      blockReason: meteora.hardRejectReason || 'meteora-blocked'
    };
  }

  if (meteora.status !== 'passed') {
    return {
      status: 'source_unavailable' as CandidatePoolStatus,
      blockReason: `meteora-${meteora.status}`
    };
  }

  const feeYield = bySource.get('pool_fee_yield');
  if (feeYield?.status === 'blocked' && parseTime(feeYield.expiresAt) > nowMs) {
    return {
      status: 'blocked' as CandidatePoolStatus,
      blockReason: feeYield.hardRejectReason
        ? `${POOL_FEE_YIELD_BLOCK_REASON_PREFIX}${feeYield.hardRejectReason}`
        : 'pool_fee_yield-blocked'
    };
  }

  const route = bySource.get('jupiter_route');
  if (!route) {
    return {
      status: 'eligible' as CandidatePoolStatus,
      blockReason: 'missing-jupiter_route'
    };
  }

  if (parseTime(route.expiresAt) <= nowMs || route.status === 'stale') {
    return {
      status: 'stale' as CandidatePoolStatus,
      blockReason: 'stale-jupiter_route'
    };
  }

  if (route.status === 'blocked') {
    return {
      status: 'blocked' as CandidatePoolStatus,
      blockReason: route.hardRejectReason || 'jupiter_route-blocked'
    };
  }

  if (route.status !== 'passed') {
    return {
      status: 'source_unavailable' as CandidatePoolStatus,
      blockReason: `jupiter_route-${route.status}`
    };
  }

  const securityStatus = resolveSecurityStatus({
    observations: input.observations,
    nowMs
  });
  if (securityStatus) {
    return securityStatus;
  }

  return {
    status: 'openable' as CandidatePoolStatus,
    blockReason: ''
  };
}

export function deriveCandidatePoolEntry(input: {
  strategyId: StrategyId;
  candidate: IngestCandidate;
  observations: CandidateSourceObservation[];
  now: Date;
}): CandidatePoolEntry {
  const { status, blockReason } = resolveStatus({
    candidate: input.candidate,
    observations: input.observations,
    now: input.now
  });
  const nowMs = input.now.getTime();
  const hardObservations = input.observations.filter((observation) =>
    REQUIRED_MARKET_SOURCES.includes(observation.source)
      || (
        SECURITY_SOURCES.includes(observation.source)
        && observation.status === 'passed'
        && parseTime(observation.expiresAt) > nowMs
      )
  );
  const score = input.observations.reduce((total, observation) => total + Math.max(0, observation.score), 0)
    + feeTvlScore(input.candidate)
    + (input.candidate.poolFeeYieldScore ?? 0);
  const safetyScore = maxPassedObservationScore(input.observations, ['gmgn', 'chain_fast_safety']);
  const feeYieldScore = feeTvlScore(input.candidate)
    + maxPassedObservationScore(input.observations, ['pool_fee_yield'])
    + (input.candidate.poolFeeYieldScore ?? 0);
  const liquidityScore = maxPassedObservationScore(input.observations, ['meteora']);
  const executionScore = maxPassedObservationScore(input.observations, ['jupiter_route']);
  const auxiliaryScore = input.candidate.auxiliaryScore ?? input.candidate.auxSignalScore ?? 0;
  const fallbackFreshness = new Date(input.now.getTime()).toISOString();
  const freshnessExpiresAt = hardObservations.length > 0
    ? minIso(hardObservations.map((observation) => observation.expiresAt), fallbackFreshness)
    : fallbackFreshness;
  const updatedAt = maxIso(input.observations.map((observation) => observation.observedAt), input.now.toISOString());

  return {
    strategyId: input.strategyId,
    poolAddress: input.candidate.address,
    tokenMint: input.candidate.mint,
    tokenSymbol: input.candidate.symbol,
    status,
    openable: status === 'openable',
    score,
    blockReason,
    freshnessExpiresAt,
    updatedAt,
    candidate: {
      ...input.candidate,
      safetyScore,
      feeYieldScore,
      liquidityScore,
      executionScore,
      auxiliaryScore,
      selectionScore: score
    }
  };
}
