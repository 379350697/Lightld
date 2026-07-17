import { loadStrategyConfig } from '../config/loader.ts';
import {
  fetchTokenSafetyBatch,
  GMGN_SAFETY_DEFERRED_ERROR,
  type TokenSafetyResult
} from '../ingest/gmgn/token-safety-client.ts';
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
import type {
  CandidatePoolEntry,
  CandidatePoolReader,
  CandidatePoolWriter,
  CandidateSourceAdapter
} from './types.ts';
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

export type CandidateWorkerRotationState = {
  priorityCursor: number;
  discoveryCursor: number;
  singleSlotTurn?: number;
  deferredPoolAddresses?: Set<string>;
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
  routeMaximumPoolsPerTick?: number;
  routeDiscoveryPoolsPerTick?: number;
  rotationState?: CandidateWorkerRotationState;
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
  captureMode?: string;
  researchRecorder?: CandidateResearchRecorder;
  researchCandidateReader?: CandidatePoolReader;
  readPriorityPoolAddresses?: () => Promise<string[]>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
};

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function expiresAt(now: Date, ttlMs: number) {
  return new Date(now.getTime() + Math.max(0, ttlMs)).toISOString();
}

function takeCircular<T>(items: T[], maximum: number, cursor: number) {
  if (items.length === 0 || maximum <= 0) {
    return { items: [] as T[], nextCursor: 0 };
  }

  const count = Math.min(items.length, Math.max(0, Math.floor(maximum)));
  const start = ((Math.floor(cursor) % items.length) + items.length) % items.length;
  const selected = Array.from({ length: count }, (_, offset) => items[(start + offset) % items.length]);
  return {
    items: selected,
    nextCursor: (start + count) % items.length
  };
}

function selectRouteCandidates(input: {
  candidates: IngestCandidate[];
  priorityAddresses: string[];
  maximumPools: number;
  discoveryPools: number;
  rotationState: CandidateWorkerRotationState;
}) {
  const maximumPools = Math.max(1, Math.floor(input.maximumPools));
  const discoveryPools = Math.min(maximumPools, Math.max(1, Math.floor(input.discoveryPools)));
  const priorityOrder = new Map(input.priorityAddresses.map((address, index) => [address, index] as const));
  const priority = input.candidates
    .filter((candidate) => priorityOrder.has(candidate.address))
    .sort((left, right) => (priorityOrder.get(left.address) ?? 0) - (priorityOrder.get(right.address) ?? 0));
  const discovery = input.candidates.filter((candidate) => !priorityOrder.has(candidate.address));

  if (maximumPools === 1 && priority.length > 0 && discovery.length > 0) {
    const turn = input.rotationState.singleSlotTurn ?? 0;
    const useDiscovery = turn % 4 === 3;
    input.rotationState.singleSlotTurn = turn + 1;
    const selection = useDiscovery
      ? takeCircular(discovery, 1, input.rotationState.discoveryCursor)
      : takeCircular(priority, 1, input.rotationState.priorityCursor);
    if (useDiscovery) {
      input.rotationState.discoveryCursor = selection.nextCursor;
    } else {
      input.rotationState.priorityCursor = selection.nextCursor;
    }
    return selection.items;
  }

  // Always reserve a small part of the bounded quote budget for discovery.
  // Otherwise a stable set of openable pools can permanently starve every new
  // candidate. Both sets rotate so a large priority set cannot starve itself.
  const prioritySelection = takeCircular(
    priority,
    Math.max(0, maximumPools - Math.min(
      discoveryPools,
      discovery.length,
      priority.length > 0 ? maximumPools - 1 : maximumPools
    )),
    input.rotationState.priorityCursor
  );
  const discoverySelection = takeCircular(
    discovery,
    Math.min(discoveryPools, maximumPools - prioritySelection.items.length),
    input.rotationState.discoveryCursor
  );
  input.rotationState.priorityCursor = prioritySelection.nextCursor;
  input.rotationState.discoveryCursor = discoverySelection.nextCursor;

  return [...prioritySelection.items, ...discoverySelection.items];
}

export async function runCandidateWorkerTick(options: CandidateWorkerOptions): Promise<CandidateWorkerTickResult> {
  const currentTime = options.now ?? (() => new Date());
  const now = currentTime();
  const intervalMs = options.intervalMs ?? 15 * 60_000;
  const staleMs = options.staleMs ?? Math.max(3 * 60_000, intervalMs + 5 * 60_000);
  const workerLeaseMs = options.workerLeaseMs ?? Math.max(staleMs, intervalMs + 5 * 60_000);
  const gmgnTtlMs = options.gmgnTtlMs ?? 24 * 60 * 60 * 1000;
  const gmgnMaxBatchSize = options.gmgnMaxBatchSize ?? 2;
  const gmgnSourceMode = options.gmgnSourceMode ?? 'soft';
  const routeMaximumPoolsPerTick = Math.max(1, Math.floor(options.routeMaximumPoolsPerTick ?? 5));
  const routeDiscoveryPoolsPerTick = Math.min(
    routeMaximumPoolsPerTick,
    Math.max(1, Math.floor(options.routeDiscoveryPoolsPerTick ?? 2))
  );
  const rotationState = options.rotationState ?? { priorityCursor: 0, discoveryCursor: 0 };
  const deferredPoolAddresses = rotationState.deferredPoolAddresses ?? new Set<string>();
  rotationState.deferredPoolAddresses = deferredPoolAddresses;
  const config = await loadStrategyConfig(STRATEGY_CONFIGS[options.strategy]);
  await options.writer.writeWorkerStatus({
    strategyId: options.strategy,
    status: 'running',
    observedAt: now.toISOString(),
    expiresAt: expiresAt(now, workerLeaseMs),
    details: 'candidate-worker-tick-running'
  });
  const fetchStartedAt = Date.now();
  const fetchPools = options.fetchMeteoraPoolsImpl ?? fetchMeteoraPools;
  let rows = await fetchPools({
    pageSize: options.meteoraPageSize ?? 250,
    query: options.meteoraQuery,
    sortBy: options.meteoraSortBy ?? 'fee_tvl_ratio_1h:desc',
    filterBy: options.meteoraFilterBy ?? 'tvl>=1000 && is_blacklisted=false'
  });
  const trackedPriorityAddresses = await options.readPriorityPoolAddresses?.().catch(() => []) ?? [];
  const openablePriorityAddresses = await options.poolFeeYieldStore?.readPriorityPoolAddresses?.(options.strategy).catch(() => []) ?? [];
  const presentAddresses = new Set(rows.map((row) => buildMeteoraCandidate(row).address).filter(Boolean));
  const missingPriorityAddresses = [...new Set([...trackedPriorityAddresses, ...openablePriorityAddresses])]
    .filter((address) => address && !presentAddresses.has(address))
    .slice(0, 250);
  if (missingPriorityAddresses.length > 0) {
    const missingPrioritySet = new Set(missingPriorityAddresses);
    const priorityRows = await fetchPools({
      pageSize: missingPriorityAddresses.length,
      filterBy: `pool_address=[${missingPriorityAddresses.join('|')}]`
    }).catch((error) => {
      options.logger?.warn(`[CandidateWorker] priority pool refresh failed soft: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    const seenKeys = new Set(rows.map((row) => {
      const candidate = buildMeteoraCandidate(row);
      return `${candidate.address}:${candidate.mint}`;
    }));
    rows = [...rows, ...priorityRows.filter((row) => {
      const candidate = buildMeteoraCandidate(row);
      const key = `${candidate.address}:${candidate.mint}`;
      if (!missingPrioritySet.has(candidate.address) || seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    })];
  }
  const meteoraObservedAt = currentTime();
  const fetchLatencyMs = Date.now() - fetchStartedAt;
  const priorityAddressList = [...new Set([
    // Runtime-owned/tracked positions are more important than unused openable
    // rows, followed by locally deferred safety checks.
    ...trackedPriorityAddresses,
    ...openablePriorityAddresses,
    ...deferredPoolAddresses
  ])];
  const priorityAddresses = new Set(priorityAddressList);
  let feeYieldProfiles = new Map<string, PoolFeeYieldProfile>();
  if (options.poolFeeYieldStore) {
    const maximumPools = options.poolFeeYieldMaximumPools ?? 250;
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
      observedAt: meteoraObservedAt,
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
  const newTokenPrefilter = config.poolClass === 'new-token';
  const prefiltered = rows.filter((row) => isMeteoraPoolPrefiltered(row, meteoraObservedAt, maxPoolAgeMs, {
    // Recency and DLMM bin-width are new-token LP entry rules. Applying them
    // to the large-pool spot strategy silently removes established pools from
    // its universe and makes that strategy impossible to run.
    requireRecent: newTokenPrefilter,
    requireEntryBinStep: newTokenPrefilter
  }));
  const candidates = prefiltered.map((row) => {
    const candidate = buildMeteoraCandidate(row);
    return applyPoolFeeYieldProfile(candidate, feeYieldProfiles.get(candidate.address));
  });
  const lpEligible = rankCandidatesForSafety(filterLpEligibleCandidates(candidates, config));
  const eligibleAddresses = new Set(lpEligible.map((candidate) => candidate.address));
  for (const address of deferredPoolAddresses) {
    if (!eligibleAddresses.has(address)) {
      deferredPoolAddresses.delete(address);
    }
  }
  const routeCandidates = selectRouteCandidates({
    candidates: lpEligible,
    priorityAddresses: priorityAddressList.filter((address) => eligibleAddresses.has(address)),
    maximumPools: routeMaximumPoolsPerTick,
    discoveryPools: routeDiscoveryPoolsPerTick,
    rotationState
  });
  let openableCount = 0;
  const routePassedCandidates: IngestCandidate[] = [];
  const routeEntries = new Map<string, CandidatePoolEntry>();

  for (const candidate of lpEligible) {
    await options.writer.upsertCandidate({
      strategyId: options.strategy,
      candidate,
      observedAt: meteoraObservedAt.toISOString(),
      sourceObservations: [
        buildMeteoraObservation({ strategyId: options.strategy, candidate, now: meteoraObservedAt, ttlMs: staleMs, latencyMs: fetchLatencyMs }),
        buildPoolFeeYieldObservation({
          strategyId: options.strategy,
          candidate,
          profile: feeYieldProfiles.get(candidate.address),
          now: meteoraObservedAt,
          ttlMs: staleMs
        })
      ]
    });

  }

  for (const candidate of routeCandidates) {
    const routeObservedAt = currentTime();
    const routeStartedAt = Date.now();
    const rawRouteObservation = await options.routeSource.observe(candidate, {
      strategyId: options.strategy,
      now: routeObservedAt
    }).catch((error) => buildFailedRouteObservation({
      strategyId: options.strategy,
      candidate,
      now: routeObservedAt,
      ttlMs: staleMs,
      latencyMs: Date.now() - routeStartedAt,
      reason: error instanceof Error ? error.message : String(error)
    }));
    const routeEvidenceAt = currentTime();
    const routeObservation = {
      ...rawRouteObservation,
      observedAt: routeEvidenceAt.toISOString(),
      expiresAt: expiresAt(routeEvidenceAt, staleMs)
    };
    const routeEntry = await options.writer.upsertCandidate({
      strategyId: options.strategy,
      candidate,
      observedAt: routeEvidenceAt.toISOString(),
      sourceObservations: [routeObservation]
    });
    routeEntries.set(`${candidate.address}:${candidate.mint}`, routeEntry);
    if (routeObservation.status === 'passed') {
      routePassedCandidates.push(candidate);
    }
  }

  await options.writer.markMissingOpenableStale(options.strategy, currentTime().toISOString(), lpEligible.map((candidate) => ({
    poolAddress: candidate.address,
    tokenMint: candidate.mint
  })));

  const gmgnBatch = gmgnSourceMode === 'disabled'
    ? []
    : routePassedCandidates;
  const researchCandidates: IngestCandidate[] = [];

  if (gmgnBatch.length > 0) {
    const gmgnStartedAt = Date.now();
    let results: TokenSafetyResult[];
    try {
      results = await (options.fetchTokenSafetyBatchImpl ?? ((mints) => fetchTokenSafetyBatch(mints, { maxBatchSize: gmgnMaxBatchSize })))(
        gmgnBatch.map((candidate) => candidate.mint)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn(`[CandidateWorker] GMGN source failed closed: ${message}`);
      results = gmgnBatch.map((candidate) => ({
        mint: candidate.mint,
        safe: false,
        safetyScore: 0,
        maxScore: 120,
        error: message
      }));
    }

    const resultsByMint = new Map(results.map((result) => [result.mint, result] as const));
    const latencyMs = Date.now() - gmgnStartedAt;
    const gmgnObservedAt = currentTime();
    for (const candidate of gmgnBatch) {
      const result = resultsByMint.get(candidate.mint);
      const routeEntry = routeEntries.get(`${candidate.address}:${candidate.mint}`);
      if (!result || result.error === GMGN_SAFETY_DEFERRED_ERROR) {
        // A local API-budget deferral is not negative safety evidence. Keep a
        // still-fresh persisted GMGN pass intact; a never-checked candidate
        // remains non-openable and will return through the discovery rotation.
        deferredPoolAddresses.add(candidate.address);
        if (routeEntry?.openable) {
          openableCount += 1;
          researchCandidates.push(routeEntry.candidate);
        }
        continue;
      }
      if (result.error) {
        deferredPoolAddresses.add(candidate.address);
      } else {
        deferredPoolAddresses.delete(candidate.address);
      }
      const entry = await options.writer.upsertCandidate({
        strategyId: options.strategy,
        candidate,
        observedAt: gmgnObservedAt.toISOString(),
        sourceObservations: [
          buildGmgnObservation({
            strategyId: options.strategy,
            candidate,
            now: gmgnObservedAt,
            ttlMs: result?.error ? staleMs : gmgnTtlMs,
            latencyMs,
            result
          })
        ]
      });
      if (entry.openable) {
        openableCount += 1;
        researchCandidates.push(entry.candidate);
      }
    }
  }

  const completedAt = currentTime();
  await options.writer.writeWorkerStatus({
    strategyId: options.strategy,
    status: 'ok',
    observedAt: completedAt.toISOString(),
    expiresAt: expiresAt(completedAt, workerLeaseMs),
    details: `pools=${rows.length} prefilter=${prefiltered.length} lp=${lpEligible.length} routed=${routeCandidates.length} openable=${openableCount} gmgnChecked=${gmgnBatch.length}`
  });
  options.logger?.log(
    `[CandidateWorker] pools=${rows.length} prefilter=${prefiltered.length} lp=${lpEligible.length} routed=${routeCandidates.length} openable=${openableCount} gmgnChecked=${gmgnBatch.length}`
  );

  if (options.researchRecorder) {
    let snapshotCandidates = researchCandidates;
    let shouldCaptureResearch = true;
    if (options.researchCandidateReader) {
      try {
        snapshotCandidates = (await options.researchCandidateReader.listOpenableCandidates(options.strategy, {
          now: completedAt,
          maxAgeMs: staleMs,
          limit: 20
        })).map((entry) => entry.candidate);
      } catch (error) {
        options.logger?.warn(`[CandidateWorker] strategy research candidate read degraded: ${error instanceof Error ? error.message : String(error)}`);
        shouldCaptureResearch = false;
      }
    }
    if (shouldCaptureResearch) {
      await options.researchRecorder.capture({
        strategyId: options.strategy,
        observedAt: completedAt.toISOString(),
        captureMode: options.captureMode ?? '',
        baseConfig: config,
        candidates: snapshotCandidates
      }).catch((error) => {
        options.logger?.warn(`[CandidateWorker] strategy research degraded; trading candidates unchanged: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
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
  const intervalMs = options.intervalMs ?? 15 * 60_000;
  const sleep = options.sleep ?? defaultSleep;
  let tick = 0;
  const rotationState = options.rotationState ?? { priorityCursor: 0, discoveryCursor: 0 };

  while (options.maxTicks === undefined || tick < options.maxTicks) {
    tick += 1;
    try {
      await runCandidateWorkerTick({ ...options, rotationState });
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
