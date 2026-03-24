import { z } from 'zod';

const LocalLiveExecutionConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8790),
  stateRootDir: z.string().min(1),
  accountStatePath: z.string().min(1).optional(),
  authToken: z.string().min(1).optional(),
  expectedSignerPublicKeys: z.array(z.string().min(1)).default([]),
  autoFinalizeAfterMs: z.number().int().min(0).default(5_000)
});

export type LocalLiveExecutionConfig = z.infer<typeof LocalLiveExecutionConfigSchema>;

export function loadLocalLiveExecutionConfig(env: Record<string, string | undefined> = process.env) {
  return LocalLiveExecutionConfigSchema.parse({
    host: env.LIVE_LOCAL_EXECUTION_HOST ?? '127.0.0.1',
    port: env.LIVE_LOCAL_EXECUTION_PORT ? Number(env.LIVE_LOCAL_EXECUTION_PORT) : 8790,
    stateRootDir: env.LIVE_LOCAL_EXECUTION_STATE_DIR ?? 'state/local-execution',
    accountStatePath: env.LIVE_LOCAL_EXECUTION_ACCOUNT_STATE_PATH,
    authToken: env.LIVE_LOCAL_EXECUTION_AUTH_TOKEN ?? env.LIVE_AUTH_TOKEN,
    expectedSignerPublicKeys: (env.LIVE_LOCAL_EXECUTION_EXPECTED_SIGNERS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    autoFinalizeAfterMs: env.LIVE_LOCAL_EXECUTION_AUTO_FINALIZE_AFTER_MS
      ? Number(env.LIVE_LOCAL_EXECUTION_AUTO_FINALIZE_AFTER_MS)
      : 5_000
  });
}
