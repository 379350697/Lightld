import { join } from 'node:path';

import {
  createJupiterRouteSource,
  resolveCandidateRouteQuoteSol
} from '../candidate-pool/jupiter-route-source.ts';
import { SqliteCandidatePool } from '../candidate-pool/sqlite-candidate-pool.ts';
import { runCandidateWorker } from '../candidate-pool/worker.ts';
import { loadStrategyConfig } from '../config/loader.ts';
import { JupiterClient } from '../execution/solana/jupiter-client.ts';
import { FileBackedSlidingWindowRateLimiter } from '../execution/solana/sliding-window-rate-limiter.ts';
import type { StrategyId } from '../runtime/live-cycle.ts';
import { RuntimeStateStore } from '../runtime/runtime-state-store.ts';
import { SqliteCandidateResearchRecorder } from '../strategy-research/capture.ts';
import { StrategyResearchStore } from '../strategy-research/store.ts';
import {
  resolveCandidatePoolStaleMs,
  resolveCandidateWorkerIntervalMs,
  resolveCandidateWorkerLeaseMs
} from './run-candidate-worker-args.ts';

type ParsedArgs = {
  strategy?: string;
  stateRootDir: string;
  dbPath?: string;
  intervalMs: number;
  maxTicks?: number;
  meteoraPageSize?: number;
  meteoraQuery?: string;
  meteoraSortBy?: string;
  meteoraFilterBy?: string;
  poolFeeYieldSampleIntervalMs: number;
  poolFeeYieldRetirementMs: number;
  poolFeeYieldRetentionMs: number;
  poolFeeYieldMaximumPools: number;
};

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseGmgnSourceMode(value: string | undefined): 'soft' | 'disabled' {
  return value === 'disabled' ? 'disabled' : 'soft';
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    stateRootDir: process.env.LIVE_STATE_DIR ?? 'state',
    dbPath: process.env.LIVE_CANDIDATE_POOL_DB_PATH,
    intervalMs: resolveCandidateWorkerIntervalMs(argv),
    meteoraPageSize: parseOptionalPositiveInteger(process.env.LIVE_METEORA_PAGE_SIZE) ?? 250,
    meteoraQuery: process.env.LIVE_METEORA_QUERY,
    meteoraSortBy: process.env.LIVE_METEORA_SORT_BY,
    meteoraFilterBy: process.env.LIVE_METEORA_FILTER_BY,
    poolFeeYieldSampleIntervalMs: parsePositiveInteger(process.env.LIVE_POOL_FEE_YIELD_SAMPLE_INTERVAL_MS, 15 * 60_000),
    poolFeeYieldRetirementMs: parsePositiveInteger(process.env.LIVE_POOL_FEE_YIELD_RETIREMENT_MS, 6 * 60 * 60 * 1000),
    poolFeeYieldRetentionMs: parsePositiveInteger(process.env.LIVE_POOL_FEE_YIELD_RETENTION_MS, 48 * 60 * 60 * 1000),
    poolFeeYieldMaximumPools: parsePositiveInteger(process.env.LIVE_POOL_FEE_YIELD_MAX_POOLS, 250)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--strategy' && next) {
      parsed.strategy = next;
      index += 1;
      continue;
    }

    if (current === '--state-root-dir' && next) {
      parsed.stateRootDir = next;
      index += 1;
      continue;
    }

    if (current === '--db-path' && next) {
      parsed.dbPath = next;
      index += 1;
      continue;
    }

    if (current === '--max-ticks' && next) {
      parsed.maxTicks = Number(next);
      index += 1;
      continue;
    }

    if (current === '--meteora-page-size' && next) {
      parsed.meteoraPageSize = Number(next);
      index += 1;
      continue;
    }

    if (current === '--meteora-query' && next) {
      parsed.meteoraQuery = next;
      index += 1;
      continue;
    }

    if (current === '--meteora-sort-by' && next) {
      parsed.meteoraSortBy = next;
      index += 1;
      continue;
    }

    if (current === '--meteora-filter-by' && next) {
      parsed.meteoraFilterBy = next;
      index += 1;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.strategy !== 'new-token-v1' && args.strategy !== 'large-pool-v1') {
    throw new Error('Expected --strategy to be one of: new-token-v1, large-pool-v1');
  }

  const strategy = args.strategy as StrategyId;
  const strategyConfig = await loadStrategyConfig(
    strategy === 'new-token-v1'
      ? 'src/config/strategies/new-token-v1.yaml'
      : 'src/config/strategies/large-pool-v1.yaml'
  );
  const dbPath = args.dbPath ?? join(args.stateRootDir, 'lightld-candidate-pool.sqlite');
  const writer = new SqliteCandidatePool({ path: dbPath });
  const researchStore = new StrategyResearchStore(join(args.stateRootDir, 'research', 'research.sqlite'));
  const captureMode = process.env.LIGHTLD_RUN_MODE ?? process.env.LIGHTLD_EXECUTION_MODE ?? '';
  const staleMs = resolveCandidatePoolStaleMs(process.env, args.intervalMs);
  const workerLeaseMs = resolveCandidateWorkerLeaseMs(process.env, args.intervalMs, staleMs);
  const routeQuoteSol = resolveCandidateRouteQuoteSol(process.env);
  const jupiterRateLimitCapacity = parsePositiveInteger(process.env.JUPITER_RATE_LIMIT_CAPACITY, 60);
  const jupiterRateLimitWindowMs = parsePositiveInteger(process.env.JUPITER_RATE_LIMIT_WINDOW_MS, 60_000);
  // Every candidate consumes two Jupiter quotes (entry and executable exit).
  // Keep the scanner below 75% of the shared rate budget so actual execution
  // can still quote during the same window.
  const sustainableRoutePoolsPerTick = Math.max(1, Math.floor(
    (jupiterRateLimitCapacity * args.intervalMs * 0.75) / (jupiterRateLimitWindowMs * 2)
  ));
  const routeMaximumPoolsPerTick = Math.min(
    25,
    sustainableRoutePoolsPerTick,
    parsePositiveInteger(process.env.LIVE_CANDIDATE_ROUTE_MAX_POOLS_PER_TICK, sustainableRoutePoolsPerTick)
  );
  const routeDiscoveryPoolsPerTick = Math.min(
    routeMaximumPoolsPerTick,
    parsePositiveInteger(process.env.LIVE_CANDIDATE_ROUTE_DISCOVERY_POOLS_PER_TICK, 2)
  );
  const jupiterRateLimitStatePath = process.env.JUPITER_RATE_LIMIT_STATE_PATH
    ?? join(args.stateRootDir, 'jupiter-rate-limit.json');
  const routeSource = createJupiterRouteSource({
    client: new JupiterClient({
      apiUrl: process.env.JUPITER_API_URL ?? 'https://api.jup.ag',
      apiKey: process.env.JUPITER_API_KEY,
      timeoutMs: parsePositiveInteger(process.env.LIVE_JUPITER_SOURCE_TIMEOUT_MS, 5_000),
      rateLimitCapacity: jupiterRateLimitCapacity,
      rateLimitWindowMs: jupiterRateLimitWindowMs,
      negativeRouteCacheTtlMs: parsePositiveInteger(process.env.JUPITER_NEGATIVE_ROUTE_CACHE_TTL_MS, 300_000),
      minQuoteAmountLamports: parsePositiveInteger(process.env.JUPITER_MIN_QUOTE_LAMPORTS, 1_000),
      rateLimiter: new FileBackedSlidingWindowRateLimiter({
        statePath: jupiterRateLimitStatePath,
        capacity: jupiterRateLimitCapacity,
        windowMs: jupiterRateLimitWindowMs
      })
    }),
    quoteSol: routeQuoteSol,
    slippageBps: strategyConfig.solRouteLimits.maxSlippageBps,
    maxImpactBps: strategyConfig.solRouteLimits.maxImpactBps,
    ttlMs: staleMs
  });
  const runtimeStateStore = new RuntimeStateStore(args.stateRootDir);

  try {
    await writer.open();
    const researchEnabled = (captureMode === 'mechanical-soak' || captureMode === 'economic-shadow')
      && await researchStore.openBestEffort(console);
    await runCandidateWorker({
      strategy,
      writer,
      intervalMs: args.intervalMs,
      maxTicks: args.maxTicks,
      staleMs,
      workerLeaseMs,
      routeMaximumPoolsPerTick,
      routeDiscoveryPoolsPerTick,
      gmgnMaxBatchSize: parsePositiveInteger(process.env.LIVE_GMGN_SOURCE_CONCURRENCY, 2),
      gmgnSourceMode: parseGmgnSourceMode(process.env.LIVE_GMGN_SOURCE_MODE),
      captureMode,
      researchRecorder: researchEnabled ? new SqliteCandidateResearchRecorder(researchStore) : undefined,
      researchCandidateReader: researchEnabled ? writer : undefined,
      readPriorityPoolAddresses: async () => {
        const [state, ledger] = await Promise.all([
          runtimeStateStore.readPositionState(),
          runtimeStateStore.readPositionLedger()
        ]);
        return [
          state?.activePoolAddress,
          ...(ledger?.records.filter((record) => record.lifecycleState !== 'closed').map((record) => record.activePoolAddress) ?? [])
        ].filter((address): address is string => Boolean(address));
      },
      routeSource,
      poolFeeYieldStore: writer,
      poolFeeYieldSampleIntervalMs: args.poolFeeYieldSampleIntervalMs,
      poolFeeYieldRetirementMs: args.poolFeeYieldRetirementMs,
      poolFeeYieldRetentionMs: args.poolFeeYieldRetentionMs,
      poolFeeYieldMaximumPools: args.poolFeeYieldMaximumPools,
      meteoraPageSize: args.meteoraPageSize,
      meteoraQuery: args.meteoraQuery,
      meteoraSortBy: args.meteoraSortBy,
      meteoraFilterBy: args.meteoraFilterBy,
      logger: console
    });
  } finally {
    researchStore.close();
    await writer.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
