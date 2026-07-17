import { join } from 'node:path';

import { JupiterClient } from '../execution/solana/jupiter-client.ts';
import { FileBackedSlidingWindowRateLimiter } from '../execution/solana/sliding-window-rate-limiter.ts';
import { StrategyResearchStore } from '../strategy-research/store.ts';
import { JupiterResearchMarkCollector, runResearchWorker } from '../strategy-research/worker.ts';

function integer(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const stateRoot = argument('--state-root-dir') ?? process.env.LIVE_STATE_DIR ?? 'state';
  const store = new StrategyResearchStore(join(stateRoot, 'research', 'research.sqlite'));
  await store.open();
  const capacity = integer(process.env.JUPITER_RATE_LIMIT_CAPACITY, 60);
  const windowMs = integer(process.env.JUPITER_RATE_LIMIT_WINDOW_MS, 60_000);
  const client = new JupiterClient({
    apiUrl: process.env.JUPITER_API_URL ?? 'https://api.jup.ag',
    apiKey: process.env.JUPITER_API_KEY,
    timeoutMs: integer(process.env.LIVE_JUPITER_SOURCE_TIMEOUT_MS, 5_000),
    rateLimitCapacity: capacity,
    rateLimitWindowMs: windowMs,
    rateLimiter: new FileBackedSlidingWindowRateLimiter({
      statePath: process.env.JUPITER_RATE_LIMIT_STATE_PATH ?? join(stateRoot, 'jupiter-rate-limit.json'),
      capacity,
      windowMs
    })
  });
  try {
    await runResearchWorker({
      store,
      collector: new JupiterResearchMarkCollector(client, integer(process.env.SOLANA_DEFAULT_SLIPPAGE_BPS, 100)),
      intervalMs: integer(argument('--interval-ms') ?? process.env.LIGHTLD_RESEARCH_INTERVAL_MS, 60_000),
      maxTicks: argument('--max-ticks') ? integer(argument('--max-ticks'), 1) : undefined,
      logger: console
    });
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
