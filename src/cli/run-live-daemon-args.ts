export const DEFAULT_LIVE_DAEMON_TICK_INTERVAL_MS = 10_000;
export const DEFAULT_LIVE_DAEMON_HOT_TICK_INTERVAL_MS = 2_000;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveLiveDaemonTiming(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
) {
  let tickIntervalMs = positiveInteger(
    env.LIVE_DAEMON_TICK_INTERVAL_MS,
    DEFAULT_LIVE_DAEMON_TICK_INTERVAL_MS
  );
  let hotTickIntervalMs = positiveInteger(
    env.LIVE_DAEMON_HOT_TICK_INTERVAL_MS,
    DEFAULT_LIVE_DAEMON_HOT_TICK_INTERVAL_MS
  );

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current !== '--tick-interval-ms' && current !== '--hot-tick-interval-ms') continue;
    const parsed = Number(argv[index + 1]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Expected ${current} to be a positive integer`);
    }
    if (current === '--tick-interval-ms') tickIntervalMs = parsed;
    else hotTickIntervalMs = parsed;
    index += 1;
  }

  return { tickIntervalMs, hotTickIntervalMs };
}
