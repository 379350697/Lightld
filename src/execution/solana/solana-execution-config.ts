import { join } from 'node:path';

import { z } from 'zod';

import { resolveEnvPath } from '../../shared/env-path.ts';
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
  jupiterRateLimitCapacity: z.number().int().positive().default(60),
  jupiterRateLimitWindowMs: z.number().int().positive().default(60_000),
  jupiterNegativeRouteCacheTtlMs: z.number().int().nonnegative().default(300_000),
  jupiterMinQuoteAmountLamports: z.number().int().nonnegative().default(1_000),
  jupiterRateLimitStatePath: z.string().min(1).default(join('state', 'jupiter-rate-limit.json')),
  rpc429CooldownMs: z.number().int().nonnegative().default(120_000),
  rpcTimeoutCooldownMs: z.number().int().nonnegative().default(10_000),
  rpc5xxCooldownMs: z.number().int().nonnegative().default(5_000),
  rpcEndpointMaxWaitMs: z.number().int().nonnegative().default(1_000),
  rpcEndpointMinIntervalMs: z.number().int().nonnegative().default(500),
  keypairPath: z.string().min(1),
  expectedPublicKey: z.string().min(1).optional(),
  stateRootDir: z.string().min(1).default('state/solana-execution'),
  expectedSignerPublicKeys: z.array(z.string().min(1)).default([]),
  jupiterApiUrl: z.string().min(1).default('https://api.jup.ag'),
  jupiterApiKey: z.string().min(1).optional(),
  swapProviderOrder: z.array(z.string().min(1)).default([
    'meteora-direct',
    'jupiter-v2',
    'raydium',
    'okx',
    'jupiter-v1'
  ]),
  swapProviderCooldownMs: z.number().int().nonnegative().default(30_000),
  raydiumTradeApiUrl: z.string().url().default('https://transaction-v1.raydium.io'),
  okxDexApiUrl: z.string().url().default('https://web3.okx.com'),
  okxDexChainIndex: z.string().min(1).default('501'),
  okxDexApiKey: z.string().min(1).optional(),
  okxDexSecretKey: z.string().min(1).optional(),
  okxDexPassphrase: z.string().min(1).optional(),
  okxDexProjectId: z.string().min(1).optional(),
  valuationProviderOrder: z.array(z.string().min(1)).default([
    'meteora-dlmm-quote-only',
    'birdeye-price',
    'jupiter-price-v3',
    'dexscreener-pair',
    'geckoterminal-token',
    'dlmm-active-bin-display-fallback'
  ]),
  valuationProviderCooldownMs: z.number().int().nonnegative().default(30_000),
  valuationProviderNegativeCacheTtlMs: z.number().int().nonnegative().default(60_000),
  birdeyeApiUrl: z.string().url().default('https://public-api.birdeye.so'),
  birdeyeApiKey: z.string().min(1).optional(),
  jupiterPriceApiUrl: z.string().url().default('https://api.jup.ag'),
  dexscreenerApiUrl: z.string().url().default('https://api.dexscreener.com'),
  geckoterminalApiUrl: z.string().url().default('https://api.geckoterminal.com/api/v2'),
  authToken: z.string().min(1).optional(),
  maxOutputSol: z.number().finite().positive().optional(),
  defaultSlippageBps: z.number().int().min(1).max(5000).default(100),
  residualTokenMinValueSol: z.number().finite().nonnegative().default(0.1),
  residualTokenDustMaxUiAmount: z.number().finite().nonnegative().default(0.00001),
  jitoTipLamports: z.number().int().nonnegative().optional(),
  dryRun: z.boolean().default(false),
  dryRunAddLpRebuildOnBinSlippage: z.boolean().default(true),
  dryRunAddLpRebuildMaxAttempts: z.number().int().nonnegative().default(1),
  addLpBinSlippageCooldownMs: z.number().int().nonnegative().default(300_000)
});

export type SolanaExecutionConfig = z.infer<typeof SolanaExecutionConfigSchema>;

function splitCsv(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBooleanFlag(value: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

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
    jupiterRateLimitCapacity: env.JUPITER_RATE_LIMIT_CAPACITY
      ? Number(env.JUPITER_RATE_LIMIT_CAPACITY)
      : 60,
    jupiterRateLimitWindowMs: env.JUPITER_RATE_LIMIT_WINDOW_MS
      ? Number(env.JUPITER_RATE_LIMIT_WINDOW_MS)
      : 60_000,
    jupiterNegativeRouteCacheTtlMs: env.JUPITER_NEGATIVE_ROUTE_CACHE_TTL_MS
      ? Number(env.JUPITER_NEGATIVE_ROUTE_CACHE_TTL_MS)
      : 300_000,
    jupiterMinQuoteAmountLamports: env.JUPITER_MIN_QUOTE_LAMPORTS
      ? Number(env.JUPITER_MIN_QUOTE_LAMPORTS)
      : 1_000,
    jupiterRateLimitStatePath: resolveEnvPath(
      env.JUPITER_RATE_LIMIT_STATE_PATH ?? join(env.LIVE_STATE_DIR ?? 'state', 'jupiter-rate-limit.json')
    ),
    rpc429CooldownMs: env.RPC_429_COOLDOWN_MS
      ? Number(env.RPC_429_COOLDOWN_MS)
      : 120_000,
    rpcTimeoutCooldownMs: env.RPC_TIMEOUT_COOLDOWN_MS
      ? Number(env.RPC_TIMEOUT_COOLDOWN_MS)
      : 10_000,
    rpc5xxCooldownMs: env.RPC_5XX_COOLDOWN_MS
      ? Number(env.RPC_5XX_COOLDOWN_MS)
      : 5_000,
    rpcEndpointMaxWaitMs: env.RPC_ENDPOINT_MAX_WAIT_MS
      ? Number(env.RPC_ENDPOINT_MAX_WAIT_MS)
      : 1_000,
    rpcEndpointMinIntervalMs: env.RPC_ENDPOINT_MIN_INTERVAL_MS
      ? Number(env.RPC_ENDPOINT_MIN_INTERVAL_MS)
      : 500,
    keypairPath: resolveEnvPath(env.SOLANA_KEYPAIR_PATH),
    expectedPublicKey: env.SOLANA_EXPECTED_PUBLIC_KEY,
    stateRootDir: resolveEnvPath(env.SOLANA_EXECUTION_STATE_DIR ?? 'state/solana-execution'),
    expectedSignerPublicKeys: splitCsv(
      env.SOLANA_EXPECTED_SIGNER_PUBLIC_KEYS ?? env.SOLANA_EXPECTED_SIGNERS
    ),
    jupiterApiUrl: env.JUPITER_API_URL ?? 'https://api.jup.ag',
    jupiterApiKey: env.JUPITER_API_KEY,
    swapProviderOrder: splitCsv(env.SWAP_PROVIDER_ORDER).length > 0
      ? splitCsv(env.SWAP_PROVIDER_ORDER)
      : undefined,
    swapProviderCooldownMs: env.SWAP_PROVIDER_COOLDOWN_MS
      ? Number(env.SWAP_PROVIDER_COOLDOWN_MS)
      : 30_000,
    raydiumTradeApiUrl: env.RAYDIUM_TRADE_API_URL ?? 'https://transaction-v1.raydium.io',
    okxDexApiUrl: env.OKX_DEX_API_URL ?? 'https://web3.okx.com',
    okxDexChainIndex: env.OKX_DEX_CHAIN_INDEX ?? '501',
    okxDexApiKey: env.OKX_DEX_API_KEY,
    okxDexSecretKey: env.OKX_DEX_SECRET_KEY,
    okxDexPassphrase: env.OKX_DEX_PASSPHRASE,
    okxDexProjectId: env.OKX_DEX_PROJECT_ID,
    valuationProviderOrder: splitCsv(env.VALUATION_PROVIDER_ORDER).length > 0
      ? splitCsv(env.VALUATION_PROVIDER_ORDER)
      : undefined,
    valuationProviderCooldownMs: env.VALUATION_PROVIDER_COOLDOWN_MS
      ? Number(env.VALUATION_PROVIDER_COOLDOWN_MS)
      : 30_000,
    valuationProviderNegativeCacheTtlMs: env.VALUATION_PROVIDER_NEGATIVE_CACHE_TTL_MS
      ? Number(env.VALUATION_PROVIDER_NEGATIVE_CACHE_TTL_MS)
      : 60_000,
    birdeyeApiUrl: env.BIRDEYE_API_URL ?? 'https://public-api.birdeye.so',
    birdeyeApiKey: env.BIRDEYE_API_KEY,
    jupiterPriceApiUrl: env.JUPITER_PRICE_API_URL ?? env.JUPITER_API_URL ?? 'https://api.jup.ag',
    dexscreenerApiUrl: env.DEXSCREENER_API_URL ?? 'https://api.dexscreener.com',
    geckoterminalApiUrl: env.GECKOTERMINAL_API_URL ?? 'https://api.geckoterminal.com/api/v2',
    authToken: env.SOLANA_EXECUTION_AUTH_TOKEN ?? env.LIVE_AUTH_TOKEN,
    maxOutputSol: env.SOLANA_MAX_OUTPUT_SOL
      ? Number(env.SOLANA_MAX_OUTPUT_SOL)
      : undefined,
    defaultSlippageBps: env.SOLANA_DEFAULT_SLIPPAGE_BPS
      ? Number(env.SOLANA_DEFAULT_SLIPPAGE_BPS)
      : 100,
    residualTokenMinValueSol: env.SOLANA_RESIDUAL_TOKEN_MIN_VALUE_SOL
      ? Number(env.SOLANA_RESIDUAL_TOKEN_MIN_VALUE_SOL)
      : env.LIVE_RESIDUAL_TOKEN_SWEEP_MIN_VALUE_SOL
        ? Number(env.LIVE_RESIDUAL_TOKEN_SWEEP_MIN_VALUE_SOL)
        : 0.1,
    residualTokenDustMaxUiAmount: env.SOLANA_RESIDUAL_TOKEN_DUST_MAX_UI_AMOUNT
      ? Number(env.SOLANA_RESIDUAL_TOKEN_DUST_MAX_UI_AMOUNT)
      : 0.00001,
    jitoTipLamports: env.JITO_TIP_LAMPORTS
      ? Number(env.JITO_TIP_LAMPORTS)
      : undefined,
    dryRun: parseBooleanFlag(env.SOLANA_EXECUTION_DRY_RUN),
    dryRunAddLpRebuildOnBinSlippage: env.SOLANA_DRY_RUN_ADD_LP_REBUILD_ON_BIN_SLIPPAGE
      ? parseBooleanFlag(env.SOLANA_DRY_RUN_ADD_LP_REBUILD_ON_BIN_SLIPPAGE)
      : true,
    dryRunAddLpRebuildMaxAttempts: env.SOLANA_DRY_RUN_ADD_LP_REBUILD_MAX_ATTEMPTS
      ? Number(env.SOLANA_DRY_RUN_ADD_LP_REBUILD_MAX_ATTEMPTS)
      : 1,
    addLpBinSlippageCooldownMs: env.SOLANA_ADD_LP_BIN_SLIPPAGE_COOLDOWN_MS
      ? Number(env.SOLANA_ADD_LP_BIN_SLIPPAGE_COOLDOWN_MS)
      : 300_000
  });
}
