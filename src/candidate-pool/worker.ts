import { loadStrategyConfig } from '../config/loader.ts';
import { fetchTokenSafetyBatch, type TokenSafetyResult } from '../ingest/gmgn/token-safety-client.ts';
import { fetchMeteoraPools } from '../ingest/meteora/client.ts';
import {
  filterLpEligibleCandidates,
  rankCandidatesForSafety,
  type IngestCandidate
} from '../runtime/ingest-candidate-selection.ts';
import type { StrategyId } from '../runtime/live-cycle.ts';
import {
  applyPoolFeeYieldProfile,
  buildPoolFeeYieldObservation,
  type PoolFeeYieldProfile,
  type PoolFeeYieldStore
} from './pool-fee-yield.ts';
import { buildFailedRouteObservation, buildGmgnObservation, buildMeteoraObservation } from './source-observations.ts';
import type { CandidatePoolWriter, CandidateSourceAdapter } from './types.ts';
import { buildMeteoraCandidate, isMeteoraPoolPrefiltered } from './meteora-candidate-builder.ts';
import type { CandidateResearchRecorder } from '../strategy-research/capture.ts';

const STRATEGY_CONFIGS = {
  'new-token-v1': 'src/config/strategies/new-token-v1.yaml',
  'large-pool-v1': 'src/config/strategies/large-pool-v1.yaml'
} as const;

export type CandidateWorkerTickResult = {
  fetchedPoolCount: number;
  prefilteredCount: number;
  lpEligibleCount: number;
  openableCount: number;
  gmgnCheckedCount: number;
};

type FetchMeteoraPoolsImpl = (options?: Parameters<typeof fetchMeteoraPools>[0]) => Promise<Record<string, unknown>[]>;
type FetchTokenSafetyBatchImpl = (mints: string[]) => Promise<TokenSafetyResult[]>;

export type CandidateWorkerOptions = {
  strategy: StrategyId;
  writer: CandidatePoolWriter;
  intervalMs?: number;
  maxTicks?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  staleMs?: number;
  gmgnTtlMs?: number;
  gmgnMaxBatchSize?: number;
  workerLeaseMs?: number;
  meteoraPageSize?: number;
  meteoraQuery?: string;
  meteoraSortBy?: string;
  meteoraFilterBy?: string;
  poolFeeYieldStore?: PoolFeeYieldStore;
  poolFeeYieldSampleIntervalMs?: number;
  poolFeeYieldRetirementMs?: number;
  poolFeeYieldRetentionMs?: number;
  poolFeeYieldMaximumPools?: number;
  fetchMeteoraPoolsImpl?: FetchMeteoraPoolsImpl;
  fetchTokenSafetyBatchImpl?: FetchTokenSafetyBatchImpl;
  routeSource: CandidateSourceAdapter;
  gmgnSourceMode?: 'soft' | 'disabled';
  runSoftSourcesInBackground?: boolean;
  captureMode?: string;
  researchRecorder?: CandidateResearchRecorder;
  readPriorityPoolAddresses?: () => Promise<string[]>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
};

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function resolveGmgnCandidateBatch(candidates: IngestCandidate[], maxBatchSize: number) {
  return candidates.slice(0, Math.max(0, maxBatchSize));
}

function expiresAt(now: Date, ttlMs: number) {
  return new Date(now.getTime() + Math.max(0, ttlMs)).toISOString();
}

export async function runCandidateWorkerTick(options: CandidateWorkerOptions): Promise<CandidateWorkerTickResult> {
  const now = options.now?.() ?? new Date();
  const staleMs = options.staleMs ?? 45_000;
  const workerLeaseMs = options.workerLeaseMs ?? staleMs;
  const gmgnTtlMs = options.gmgnTtlMs ?? 24 * 60 * 60 * 1000;
  const gmgnMaxBatchSize = options.gmgnMaxBatchSize ?? 1;
  const gmgnSourceMode = options.gmgnSourceMode ?? 'soft';
  const config = await loadStrategyConfig(STRATEGY_CONFIGS[options.strategy]);
  await options.writer.writeWorkerStatus({
    strategyId: options.strategy,
    status: 'running',
    observedAt: now.toISOString(),
    expiresAt: expiresAt(now, workerLeaseMs),
    details: 'candidate-worker-tick-running'
  });
  const fetchStartedAt = Date.now();
  const rows = await (options.fetchMeteoraPoolsImpl ?? fetchMeteoraPools)({
    pageSize: options.meteoraPageSize ?? 1000,
    query: options.meteoraQuery,
    sortBy: options.meteoraSortBy ?? 'fee_tvl_ratio_1h:desc',
    filterBy: options.meteoraFilterBy ?? 'tvl>=1000 && is_blacklisted=false'
  });
  const fetchLatencyMs = Date.now() - fetchStartedAt;
  let feeYieldProfiles = new Map<string, PoolFeeYieldProfile>();
  if (options.poolFeeYieldStore) {
    const maximumPools = options.poolFeeYieldMaximumPools ?? 250;
    const priorityAddresses = new Set([
      ...(await options.poolFeeYieldStore.readPriorityPoolAddresses?.(options.strategy).catch(() => []) ?? []),
      ...(await options.readPriorityPoolAddresses?.().catch(() => []) ?? [])
    ]);
    const feeRows = [...rows.slice(0, maximumPools)];
    const sampledAddresses = new Set(feeRows.map((row) => buildMeteoraCandidate(row).address));
    for (const row of rows) {
      const address = buildMeteoraCandidate(row).address;
      if (address && priorityAddresses.has(address) && !sampledAddresses.has(address)) {
        feeRows.push(row);
        sampledAddresses.add(address);
      }
    }
    feeYieldProfiles = await options.poolFeeYieldStore.recordPoolFeeYieldSamples({
      strategyId: options.strategy,
      rows: feeRows,
      observedAt: now,
      sampleIntervalMs: options.poolFeeYieldSampleIntervalMs,
      minTvlUsd: config.filters.minLiquidityUsd,
      retirementMs: options.poolFeeYieldRetirementMs,
      retentionMs: options.poolFeeYieldRetentionMs
    }).catch((error) => {
      options.logger?.warn(`[CandidateWorker] pool fee yield sampling failed soft: ${error instanceof Error ? error.message : String(error)}`);
      return new Map<string, PoolFeeYieldProfile>();
    });
  }
  const maxPoolAgeMs = 3 * 24 * 60 * 60 * 1000;
  const prefiltered = rows.filter((row) => isMeteoraPoolPrefiltered(row, now, maxPoolAgeMs));
  const candidates = prefiltered.map((row) => {
    const candidate = buildMeteoraCandidate(row);
    return applyPoolFeeYieldProfile(candidate, feeYieldProfiles.get(candidate.address));
  });
  const lpEligible = rankCandidatesForSafety(filterLpEligibleCandidates(candidates, config));
  let openableCount = 0;
  const routeOpenableCandidates: IngestCandidate[] = [];

  for (const candidate of lpEligible) {
    await options.writer.upsertCandidate({
      strategyId: options.strategy,
      candidate,
      observedAt: now.toISOString(),
      sourceObservations: [
        buildMeteoraObservation({ strategyId: options.strategy, candidate, now, ttlMs: staleMs, latencyMs: fetchLatencyMs }),
        buildPoolFeeYieldObservation({
          strategyId: options.strategy,
          candidate,
          profile: feeYieldProfiles.get(candidate.address),
          now,
          ttlMs: staleMs
        })
      ]
    });

    const routeStartedAt = Date.now();
    const routeObservation = await options.routeSource.observe(candidate, {
      strategyId: options.strategy,
      now
    }).catch((error) => buildFailedRouteObservation({
      strategyId: options.strategy,
      candidate,
      now,
      ttlMs: staleMs,
      latencyMs: Date.now() - routeStartedAt,
      reason: error instanceof Error ? error.message : String(error)
    }));
    const entry = await options.writer.upsertCandidate({
      strategyId: options.strategy,
      candidate,
      observedAt: now.toISOString(),
      sourceObservations: [routeObservation]
    });
    if (entry.openable) {
      routeOpenableCandidates.push(candidate);
      openableCount += 1;
    }
  }

  await options.writer.markMissingOpenableStale(options.strategy, now.toISOString(), lpEligible.map((candidate) => ({
    poolAddress: candidate.address,
    tokenMint: candidate.mint
  })));

  const gmgnBatch = gmgnSourceMode === 'disabled'
    ? []
    : resolveGmgnCandidateBatch(routeOpenableCandidates, gmgnMaxBatchSize);
  const hardOpenableCount = openableCount;
  const hardCompletedAt = new Date();
  await options.writer.writeWorkerStatus({
    strategyId: options.strategy,
    status: 'ok',
    observedAt: hardCompletedAt.toISOString(),
    expiresAt: expiresAt(hardCompletedAt, workerLeaseMs),
    details: `pools=${rows.length} prefilter=${prefiltered.length} lp=${lpEligible.length} openable=${hardOpenableCount} gmgnChecked=${gmgnBatch.length}${options.runSoftSourcesInBackground ? ' gmgn=background' : ''}`
  });

  const runGmgnSoftSource = async () => {
    let gmgnBlockedCount = 0;
    const gmgnBlockedKeys = new Set<string>();
    const gmgnSafetyScores = new Map<string, number>();
    const gmgnStartedAt = Date.now();
    try {
      const results = await (options.fetchTokenSafetyBatchImpl ?? ((mints) => fetchTokenSafetyBatch(mints, { maxBatchSize: gmgnMaxBatchSize })))(
        gmgnBatch.map((candidate) => candidate.mint)
      );
      const resultsByMint = new Map(results.map((result) => [result.mint, result] as const));
      const latencyMs = Date.now() - gmgnStartedAt;
      const gmgnObservedAt = options.runSoftSourcesInBackground ? new Date() : now;
      for (const candidate of gmgnBatch) {
        const entry = await options.writer.upsertCandidate({
          strategyId: options.strategy,
          candidate,
          observedAt: gmgnObservedAt.toISOString(),
          sourceObservations: [
            buildGmgnObservation({
              strategyId: options.strategy,
              candidate,
              now: gmgnObservedAt,
              ttlMs: gmgnTtlMs,
              latencyMs,
              result: resultsByMint.get(candidate.mint)
            })
          ]
        });
        if (!entry.openable) {
          gmgnBlockedCount += 1;
          gmgnBlockedKeys.add(`${candidate.address}\0${candidate.mint}`);
        } else {
          const safetyScore = resultsByMint.get(candidate.mint)?.safetyScore;
          if (safetyScore !== undefined) gmgnSafetyScores.set(`${candidate.address}\0${candidate.mint}`, safetyScore);
        }
      }
    } catch (error) {
      options.logger?.warn(`[CandidateWorker] GMGN source failed soft: ${error instanceof Error ? error.message : String(error)}`);
    }

    const finalOpenableCount = Math.max(0, hardOpenableCount - gmgnBlockedCount);
    if (!options.runSoftSourcesInBackground) {
      const completedAt = new Date();
      await options.writer.writeWorkerStatus({
        strategyId: options.strategy,
        status: 'ok',
        observedAt: completedAt.toISOString(),
        expiresAt: expiresAt(completedAt, workerLeaseMs),
        details: `pools=${rows.length} prefilter=${prefiltered.length} lp=${lpEligible.length} openable=${finalOpenableCount} gmgnChecked=${gmgnBatch.length}`
      });
    }
    options.logger?.log(
      `[CandidateWorker] pools=${rows.length} prefilter=${prefiltered.length} lp=${lpEligible.length} openable=${finalOpenableCount} gmgnChecked=${gmgnBatch.length}`
    );
    const postGmgnCandidates = routeOpenableCandidates
      .filter((candidate) => !gmgnBlockedKeys.has(`${candidate.address}\0${candidate.mint}`))
      .map((candidate) => ({
        ...candidate,
        safetyScore: gmgnSafetyScores.get(`${candidate.address}\0${candidate.mint}`) ?? candidate.safetyScore
      }));
    return { finalOpenableCount, postGmgnCandidates };
  };

  let researchCandidates = routeOpenableCandidates;
  if (gmgnBatch.length > 0 && options.runSoftSourcesInBackground) {
    void runGmgnSoftSource().catch((error) => {
      options.logger?.warn(`[CandidateWorker] GMGN source failed soft: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else if (gmgnBatch.length > 0) {
    const result = await runGmgnSoftSource();
    openableCount = result.finalOpenableCount;
    researchCandidates = result.postGmgnCandidates;
  } else {
    options.logger?.log(
      `[CandidateWorker] pools=${rows.length} prefilter=${prefiltered.length} lp=${lpEligible.length} openable=${openableCount} gmgnChecked=${gmgnBatch.length}`
    );
  }

  if (options.researchRecorder) {
    await options.researchRecorder.capture({
      strategyId: options.strategy,
      observedAt: now.toISOString(),
      captureMode: options.captureMode ?? '',
      baseConfig: config,
      candidates: researchCandidates
    }).catch((error) => {
      options.logger?.warn(`[CandidateWorker] strategy research degraded; trading candidates unchanged: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    fetchedPoolCount: rows.length,
    prefilteredCount: prefiltered.length,
    lpEligibleCount: lpEligible.length,
    openableCount,
    gmgnCheckedCount: gmgnBatch.length
  };
}

export async function runCandidateWorker(options: CandidateWorkerOptions) {
  const intervalMs = options.intervalMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;
  let tick = 0;

  while (options.maxTicks === undefined || tick < options.maxTicks) {
    tick += 1;
    try {
      await runCandidateWorkerTick(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date();
      await options.writer.writeWorkerStatus({
        strategyId: options.strategy,
        status: 'failed',
        observedAt: failedAt.toISOString(),
        expiresAt: failedAt.toISOString(),
        details: message
      }).catch((statusError) => {
        options.logger?.error(`[CandidateWorker] failed to write failed worker status: ${statusError instanceof Error ? statusError.message : String(statusError)}`);
      });
      options.logger?.error(`[CandidateWorker] tick failed: ${message}`);
    }

    if (options.maxTicks !== undefined && tick >= options.maxTicks) {
      break;
    }

    await sleep(intervalMs);
  }
}
