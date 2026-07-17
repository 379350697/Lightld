import type { IngestCandidate } from '../runtime/ingest-candidate-selection.ts';
import type { StrategyId } from '../runtime/live-cycle.ts';

import type { PoolFeeYieldStore } from './pool-fee-yield.ts';

export type CandidateSourceName = 'meteora' | 'jupiter_route' | 'gmgn' | 'chain_fast_safety' | 'pool_fee_yield';
export type CandidateSourceStatus = 'passed' | 'blocked' | 'failed' | 'deferred' | 'stale';
export type CandidatePoolStatus = 'observed' | 'eligible' | 'openable' | 'blocked' | 'stale' | 'source_unavailable';
export type CandidateWorkerStatus = 'running' | 'ok' | 'failed';

export type CandidateSourceObservation = {
  strategyId: StrategyId;
  poolAddress: string;
  tokenMint: string;
  source: CandidateSourceName;
  status: CandidateSourceStatus;
  observedAt: string;
  expiresAt: string;
  latencyMs: number;
  score: number;
  hardRejectReason: string;
  rawJson: Record<string, unknown>;
};

export type CandidatePoolUpsert = {
  strategyId: StrategyId;
  candidate: IngestCandidate;
  observedAt: string;
  sourceObservations: CandidateSourceObservation[];
};

export type CandidatePoolEntry = {
  strategyId: StrategyId;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  status: CandidatePoolStatus;
  openable: boolean;
  score: number;
  blockReason: string;
  freshnessExpiresAt: string;
  updatedAt: string;
  candidate: IngestCandidate;
};

export type CandidatePoolReaderOptions = {
  now?: Date;
  excludedMints?: string[];
  excludedTargets?: Array<{ poolAddress?: string; tokenMint?: string }>;
  maxAgeMs?: number;
  requireFreshWorker?: boolean;
  limit?: number;
};

export interface CandidatePoolReader {
  listOpenableCandidates(strategyId: StrategyId, options?: CandidatePoolReaderOptions): Promise<CandidatePoolEntry[]>;
  selectOpenableCandidate(strategyId: StrategyId, options?: CandidatePoolReaderOptions): Promise<CandidatePoolEntry | null>;
}

export interface CandidatePoolWriter {
  upsertCandidate(input: CandidatePoolUpsert): Promise<CandidatePoolEntry>;
  markMissingOpenableStale(strategyId: StrategyId, observedAt: string, seenKeys: Array<{ poolAddress: string; tokenMint: string }>): Promise<void>;
  writeWorkerStatus(input: {
    strategyId: StrategyId;
    status: CandidateWorkerStatus;
    observedAt: string;
    expiresAt: string;
    details?: string;
  }): Promise<void>;
}

export type CandidatePoolFeeYieldWriter = CandidatePoolWriter & PoolFeeYieldStore;

export type CandidateSourceAdapter = {
  source: CandidateSourceName;
  observe(candidate: IngestCandidate, context: { strategyId: StrategyId; now: Date }): Promise<CandidateSourceObservation>;
};
