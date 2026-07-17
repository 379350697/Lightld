import type { IngestCandidate } from '../runtime/ingest-candidate-selection.ts';
import type { StrategyId } from '../runtime/live-cycle.ts';
import type {
  CandidatePoolEntry,
  CandidatePoolStatus,
  CandidateSourceName,
  CandidateSourceObservation
} from './types.ts';

const REQUIRED_HARD_SOURCES: CandidateSourceName[] = ['meteora', 'jupiter_route', 'gmgn'];
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

  const gmgn = bySource.get('gmgn');
  if (!gmgn) {
    return {
      status: 'eligible' as CandidatePoolStatus,
      blockReason: 'missing-gmgn'
    };
  }

  if (parseTime(gmgn.expiresAt) <= nowMs || gmgn.status === 'stale') {
    return {
      status: 'stale' as CandidatePoolStatus,
      blockReason: 'stale-gmgn'
    };
  }

  if (gmgn.status === 'blocked') {
    return {
      status: 'blocked' as CandidatePoolStatus,
      blockReason: gmgn.hardRejectReason
        ? `${GMGN_BLOCK_REASON_PREFIX}${gmgn.hardRejectReason}`
        : 'gmgn-blocked'
    };
  }

  if (gmgn.status !== 'passed') {
    return {
      status: 'source_unavailable' as CandidatePoolStatus,
      blockReason: `gmgn-${gmgn.status}`
    };
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
  const hardObservations = input.observations.filter((observation) =>
    REQUIRED_HARD_SOURCES.includes(observation.source)
  );
  const score = input.observations.reduce((total, observation) => total + Math.max(0, observation.score), 0);
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
      safetyScore: input.observations.find((observation) => observation.source === 'gmgn' && observation.status === 'passed')?.score
    }
  };
}
