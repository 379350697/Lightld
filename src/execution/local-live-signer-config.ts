import { z } from 'zod';

const LocalLiveSignerConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8787),
  keypairPath: z.string().min(1),
  expectedPublicKey: z.string().min(1).optional(),
  signerId: z.string().min(1).optional(),
  authToken: z.string().min(1).optional(),
  maxOutputSol: z.number().finite().positive().optional()
});

export type LocalLiveSignerConfig = z.infer<typeof LocalLiveSignerConfigSchema>;

export function loadLocalLiveSignerConfig(env: Record<string, string | undefined> = process.env) {
  return LocalLiveSignerConfigSchema.parse({
    host: env.LIVE_LOCAL_SIGNER_HOST ?? '127.0.0.1',
    port: env.LIVE_LOCAL_SIGNER_PORT ? Number(env.LIVE_LOCAL_SIGNER_PORT) : 8787,
    keypairPath: env.LIVE_LOCAL_SIGNER_KEYPAIR_PATH,
    expectedPublicKey: env.LIVE_LOCAL_SIGNER_EXPECTED_PUBLIC_KEY,
    signerId: env.LIVE_LOCAL_SIGNER_ID,
    authToken: env.LIVE_LOCAL_SIGNER_AUTH_TOKEN,
    maxOutputSol: env.LIVE_LOCAL_SIGNER_MAX_OUTPUT_SOL
      ? Number(env.LIVE_LOCAL_SIGNER_MAX_OUTPUT_SOL)
      : undefined
  });
}

