import { join } from 'node:path';

import { z } from 'zod';

const MirrorConfigSchema = z.object({
  enabled: z.boolean(),
  path: z.string().min(1),
  queueCapacity: z.number().int().positive(),
  batchSize: z.number().int().positive(),
  flushIntervalMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  cooldownMs: z.number().int().positive(),
  failureThreshold: z.number().int().positive()
});

export type MirrorConfig = z.infer<typeof MirrorConfigSchema>;

function parseBoolean(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value ?? '');
}

function parseInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

export function loadMirrorConfig(
  env: Record<string, string | undefined> = process.env
): MirrorConfig {
  const stateDir = env.LIVE_STATE_DIR ?? 'state';

  return MirrorConfigSchema.parse({
    enabled: parseBoolean(env.LIVE_DB_MIRROR_ENABLED),
    path: env.LIVE_DB_MIRROR_PATH ?? join(stateDir, 'lightld-observability.sqlite'),
    queueCapacity: parseInteger(env.LIVE_DB_MIRROR_QUEUE_CAPACITY, 1000),
    batchSize: parseInteger(env.LIVE_DB_MIRROR_BATCH_SIZE, 64),
    flushIntervalMs: parseInteger(env.LIVE_DB_MIRROR_FLUSH_INTERVAL_MS, 250),
    maxRetries: parseInteger(env.LIVE_DB_MIRROR_MAX_RETRIES, 2),
    cooldownMs: parseInteger(env.LIVE_DB_MIRROR_COOLDOWN_MS, 60_000),
    failureThreshold: parseInteger(env.LIVE_DB_MIRROR_FAILURE_THRESHOLD, 3)
  });
}
