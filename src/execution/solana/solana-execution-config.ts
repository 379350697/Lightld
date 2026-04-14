import { z } from 'zod';

import { resolveRpcEndpointPolicy } from './rpc-endpoint-policy.ts';

const SolanaExecutionConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8791),
  rpcUrl: z.string().url(),
  writeRpcUrls: z.array(z.string().url()).min(1),
  readRpcUrls: z.array(z.string().url()).min(1),
  dlmmRpcUrl: z.string().url(),
  keypairPath: z.string().min(1),
  expectedPublicKey: z.string().min(1).optional(),
  jupiterApiUrl: z.string().min(1).default('https://api.jup.ag'),
  jupiterApiKey: z.string().min(1).optional(),
  authToken: z.string().min(1).optional(),
  maxOutputSol: z.number().finite().positive().optional(),
  defaultSlippageBps: z.number().int().min(1).max(5000).default(100),
  jitoTipLamports: z.number().int().nonnegative().optional()
});

export type SolanaExecutionConfig = z.infer<typeof SolanaExecutionConfigSchema>;

export function loadSolanaExecutionConfig(
  env: Record<string, string | undefined> = process.env
): SolanaExecutionConfig {
  const rpcPolicy = resolveRpcEndpointPolicy(env);

  return SolanaExecutionConfigSchema.parse({
    host: env.SOLANA_EXECUTION_HOST ?? '127.0.0.1',
    port: env.SOLANA_EXECUTION_PORT ? Number(env.SOLANA_EXECUTION_PORT) : 8791,
    rpcUrl: rpcPolicy.writeRpcUrls[0],
    writeRpcUrls: rpcPolicy.writeRpcUrls,
    readRpcUrls: rpcPolicy.readRpcUrls,
    dlmmRpcUrl: rpcPolicy.dlmmRpcUrl,
    keypairPath: env.SOLANA_KEYPAIR_PATH,
    expectedPublicKey: env.SOLANA_EXPECTED_PUBLIC_KEY,
    jupiterApiUrl: env.JUPITER_API_URL ?? 'https://api.jup.ag',
    jupiterApiKey: env.JUPITER_API_KEY,
    authToken: env.SOLANA_EXECUTION_AUTH_TOKEN ?? env.LIVE_AUTH_TOKEN,
    maxOutputSol: env.SOLANA_MAX_OUTPUT_SOL
      ? Number(env.SOLANA_MAX_OUTPUT_SOL)
      : undefined,
    defaultSlippageBps: env.SOLANA_DEFAULT_SLIPPAGE_BPS
      ? Number(env.SOLANA_DEFAULT_SLIPPAGE_BPS)
      : 100,
    jitoTipLamports: env.JITO_TIP_LAMPORTS
      ? Number(env.JITO_TIP_LAMPORTS)
      : undefined
  });
}
