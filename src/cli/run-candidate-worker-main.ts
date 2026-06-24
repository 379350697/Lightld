import { join } from 'node:path';

import { createJupiterRouteSource } from '../candidate-pool/jupiter-route-source.ts';
import { SqliteCandidatePool } from '../candidate-pool/sqlite-candidate-pool.ts';
import { runCandidateWorker } from '../candidate-pool/worker.ts';
import { JupiterClient } from '../execution/solana/jupiter-client.ts';
import { FileBackedSlidingWindowRateLimiter } from '../execution/solana/sliding-window-rate-limiter.ts';
import type { StrategyId } from '../runtime/live-cycle.ts';

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
};

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseGmgnSourceMode(value: string | undefined): 'soft' | 'disabled' {
  return value === 'disabled' ? 'disabled' : 'soft';
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    stateRootDir: process.env.LIVE_STATE_DIR ?? 'state',
    dbPath: process.env.LIVE_CANDIDATE_POOL_DB_PATH,
    intervalMs: parsePositiveInteger(process.env.LIVE_CANDIDATE_WORKER_INTERVAL_MS, 15_000),
    meteoraPageSize: parseOptionalPositiveInteger(process.env.LIVE_METEORA_PAGE_SIZE),
    meteoraQuery: process.env.LIVE_METEORA_QUERY,
    meteoraSortBy: process.env.LIVE_METEORA_SORT_BY,
    meteoraFilterBy: process.env.LIVE_METEORA_FILTER_BY,
    poolFeeYieldSampleIntervalMs: parsePositiveInteger(process.env.LIVE_POOL_FEE_YIELD_SAMPLE_INTERVAL_MS, 300_000),
    poolFeeYieldRetirementMs: parsePositiveInteger(process.env.LIVE_POOL_FEE_YIELD_RETIREMENT_MS, 6 * 60 * 60 * 1000),
    poolFeeYieldRetentionMs: parsePositiveInteger(process.env.LIVE_POOL_FEE_YIELD_RETENTION_MS, 7 * 24 * 60 * 60 * 1000)
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

    if (current === '--interval-ms' && next) {
      parsed.intervalMs = Number(next);
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
  const dbPath = args.dbPath ?? join(args.stateRootDir, 'lightld-candidate-pool.sqlite');
  const writer = new SqliteCandidatePool({ path: dbPath });
  const staleMs = parsePositiveInteger(process.env.LIVE_CANDIDATE_POOL_STALE_MS, 45_000);
  const workerLeaseMs = parsePositiveInteger(
    process.env.LIVE_CANDIDATE_WORKER_LEASE_MS,
    args.intervalMs + 5_000
  );
  const routeQuoteSol = parsePositiveNumber(
    process.env.LIVE_CANDIDATE_ROUTE_QUOTE_SOL,
    parsePositiveNumber(process.env.LIVE_REQUESTED_POSITION_SOL, 0.01)
  );
  const jupiterRateLimitCapacity = parsePositiveInteger(process.env.JUPITER_RATE_LIMIT_CAPACITY, 60);
  const jupiterRateLimitWindowMs = parsePositiveInteger(process.env.JUPITER_RATE_LIMIT_WINDOW_MS, 60_000);
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
    slippageBps: parsePositiveInteger(process.env.SOLANA_DEFAULT_SLIPPAGE_BPS, 100),
    ttlMs: staleMs
  });

  try {
    await writer.open();
    await runCandidateWorker({
      strategy,
      writer,
      intervalMs: args.intervalMs,
      maxTicks: args.maxTicks,
      staleMs,
      workerLeaseMs,
      gmgnMaxBatchSize: parsePositiveInteger(process.env.LIVE_GMGN_SOURCE_CONCURRENCY, 1),
      gmgnSourceMode: parseGmgnSourceMode(process.env.LIVE_GMGN_SOURCE_MODE),
      runSoftSourcesInBackground: true,
      routeSource,
      poolFeeYieldStore: writer,
      poolFeeYieldSampleIntervalMs: args.poolFeeYieldSampleIntervalMs,
      poolFeeYieldRetirementMs: args.poolFeeYieldRetirementMs,
      poolFeeYieldRetentionMs: args.poolFeeYieldRetentionMs,
      meteoraPageSize: args.meteoraPageSize,
      meteoraQuery: args.meteoraQuery,
      meteoraSortBy: args.meteoraSortBy,
      meteoraFilterBy: args.meteoraFilterBy,
      logger: console
    });
  } finally {
    await writer.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
