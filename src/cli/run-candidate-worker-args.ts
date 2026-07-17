export const DEFAULT_CANDIDATE_WORKER_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_CANDIDATE_REFRESH_GRACE_MS = 5 * 60_000;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCandidateWorkerIntervalMs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
) {
  let intervalMs = parsePositiveInteger(
    env.LIVE_CANDIDATE_WORKER_INTERVAL_MS,
    DEFAULT_CANDIDATE_WORKER_INTERVAL_MS
  );

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === '--interval-ms') {
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('Expected --interval-ms to be a positive integer');
      }
      intervalMs = parsed;
      index += 1;
    }
  }

  return intervalMs;
}

export function resolveCandidatePoolStaleMs(
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = resolveCandidateWorkerIntervalMs([], env)
) {
  return parsePositiveInteger(
    env.LIVE_CANDIDATE_POOL_STALE_MS,
    Math.max(3 * 60_000, intervalMs + DEFAULT_CANDIDATE_REFRESH_GRACE_MS)
  );
}

export function resolveCandidateWorkerLeaseMs(
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = resolveCandidateWorkerIntervalMs([], env),
  staleMs = resolveCandidatePoolStaleMs(env, intervalMs)
) {
  return parsePositiveInteger(
    env.LIVE_CANDIDATE_WORKER_LEASE_MS,
    Math.max(staleMs, intervalMs + DEFAULT_CANDIDATE_REFRESH_GRACE_MS)
  );
}
