import { z } from 'zod';

import { resolveRpcEndpointPolicy } from './rpc-endpoint-policy.ts';

const SolanaExecutionConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8791),
  rpcUrl: z.string().url(),
  writeRpcUrls: z.array(z.string().url()).min(1),
  readRpcUrls: z.array(z.string().url()).min(1),
  dlmmRpcUrls: z.array(z.string().url()).min(1),
  dlmmRpcUrl: z.string().url(),
  solanaReadConcurrency: z.number().int().positive().default(2),
  solanaWriteConcurrency: z.number().int().positive().default(1),
  dlmmConcurrency: z.number().int().positive().default(1),
  jupiterConcurrency: z.number().int().positive().default(2),
  rpc429CooldownMs: z.number().int().nonnegative().default(30_000),
  rpcTimeoutCooldownMs: z.number().int().nonnegative().default(10_000),
  rpc5xxCooldownMs: z.number().int().nonnegative().default(5_000),
  rpcEndpointMaxWaitMs: z.number().int().nonnegative().default(1_000),
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
    dlmmRpcUrls: rpcPolicy.dlmmRpcUrls,
    dlmmRpcUrl: rpcPolicy.dlmmRpcUrl,
    solanaReadConcurrency: env.SOLANA_RPC_READ_CONCURRENCY
      ? Number(env.SOLANA_RPC_READ_CONCURRENCY)
      : 2,
    solanaWriteConcurrency: env.SOLANA_RPC_WRITE_CONCURRENCY
      ? Number(env.SOLANA_RPC_WRITE_CONCURRENCY)
      : 1,
    dlmmConcurrency: env.SOLANA_DLMM_RPC_CONCURRENCY
      ? Number(env.SOLANA_DLMM_RPC_CONCURRENCY)
      : 1,
    jupiterConcurrency: env.JUPITER_CONCURRENCY
      ? Number(env.JUPITER_CONCURRENCY)
      : 2,
    rpc429CooldownMs: env.RPC_429_COOLDOWN_MS
      ? Number(env.RPC_429_COOLDOWN_MS)
      : 30_000,
    rpcTimeoutCooldownMs: env.RPC_TIMEOUT_COOLDOWN_MS
      ? Number(env.RPC_TIMEOUT_COOLDOWN_MS)
      : 10_000,
    rpc5xxCooldownMs: env.RPC_5XX_COOLDOWN_MS
      ? Number(env.RPC_5XX_COOLDOWN_MS)
      : 5_000,
    rpcEndpointMaxWaitMs: env.RPC_ENDPOINT_MAX_WAIT_MS
      ? Number(env.RPC_ENDPOINT_MAX_WAIT_MS)
      : 1_000,
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
