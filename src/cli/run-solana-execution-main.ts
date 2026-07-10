import { Connection } from '@solana/web3.js';
import { loadSolanaExecutionConfig } from '../execution/solana/solana-execution-config.ts';
import { JupiterClient } from '../execution/solana/jupiter-client.ts';
import { SolanaRpcClient } from '../execution/solana/solana-rpc-client.ts';
import { loadSolanaKeypair } from '../execution/solana/solana-transaction-signer.ts';
import { createSolanaExecutionServer } from '../execution/solana/solana-execution-server.ts';
import { MeteoraDlmmClient } from '../execution/solana/meteora-dlmm-client.ts';
import { RpcEndpointRegistry } from '../execution/rpc-endpoint-registry.ts';
import { FileBackedSlidingWindowRateLimiter } from '../execution/solana/sliding-window-rate-limiter.ts';
import { createDefaultSwapProviderChain } from '../execution/solana/swap-providers.ts';
import { createDefaultValuationProviderChain } from '../execution/solana/valuation-providers.ts';

function formatEndpointForLog(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.origin;
  } catch {
    return rawUrl.includes('?') ? rawUrl.slice(0, rawUrl.indexOf('?')) : rawUrl;
  }
}

function formatEndpointListForLog(urls: string[]) {
  return urls.map(formatEndpointForLog).join(', ');
}

async function main() {
  const config = loadSolanaExecutionConfig();
  const keypair = await loadSolanaKeypair({
    keypairPath: config.keypairPath,
    expectedPublicKey: config.expectedPublicKey
  });

  process.stdout.write(`Wallet: ${keypair.publicKey.toBase58()}\n`);
  process.stdout.write(`Trade RPCs: ${formatEndpointListForLog(config.writeRpcUrls)}\n`);
  process.stdout.write(`Read RPCs: ${formatEndpointListForLog(config.readRpcUrls)}\n`);
  process.stdout.write(`DLMM RPCs: ${formatEndpointListForLog(config.dlmmRpcUrls)}\n`);
  process.stdout.write(`Jupiter: ${formatEndpointForLog(config.jupiterApiUrl)}\n`);
  process.stdout.write(`Swap providers: ${config.swapProviderOrder.join(', ')}\n`);
  process.stdout.write(`Valuation providers: ${config.valuationProviderOrder.join(', ')}\n`);
  process.stdout.write(`Execution dry-run: ${config.dryRun ? 'enabled (paper, no sendTransaction)' : 'disabled'}\n`);

  const endpointRegistry = new RpcEndpointRegistry({
    rateLimitedCooldownMs: config.rpc429CooldownMs,
    timeoutCooldownMs: config.rpcTimeoutCooldownMs,
    serverErrorCooldownMs: config.rpc5xxCooldownMs,
    maxWaitMs: config.rpcEndpointMaxWaitMs,
    minRequestIntervalMs: config.rpcEndpointMinIntervalMs
  });
  endpointRegistry.registerMany([
    ...config.writeRpcUrls.map((url) => ({
      url,
      kind: 'solana-write' as const,
      maxConcurrency: config.solanaWriteConcurrency
    })),
    ...config.readRpcUrls.map((url) => ({
      url,
      kind: 'solana-read' as const,
      maxConcurrency: config.solanaReadConcurrency
    })),
    ...config.dlmmRpcUrls.map((url) => ({
      url,
      kind: 'dlmm' as const,
      maxConcurrency: config.dlmmConcurrency
    })),
    {
      url: config.jupiterApiUrl,
      kind: 'jupiter' as const,
      maxConcurrency: config.jupiterConcurrency
    }
  ]);

  const rpcClient = new SolanaRpcClient({
    rpcUrl: config.rpcUrl,
    writeRpcUrls: config.writeRpcUrls,
    readRpcUrls: config.readRpcUrls,
    endpointRegistry
  });
  const jupiterClient = new JupiterClient({
    apiUrl: config.jupiterApiUrl,
    apiKey: config.jupiterApiKey,
    endpointRegistry,
    rateLimitCapacity: config.jupiterRateLimitCapacity,
    rateLimitWindowMs: config.jupiterRateLimitWindowMs,
    negativeRouteCacheTtlMs: config.jupiterNegativeRouteCacheTtlMs,
    minQuoteAmountLamports: config.jupiterMinQuoteAmountLamports,
    rateLimiter: new FileBackedSlidingWindowRateLimiter({
      statePath: config.jupiterRateLimitStatePath,
      capacity: config.jupiterRateLimitCapacity,
      windowMs: config.jupiterRateLimitWindowMs
    })
  });

  const dlmmClient = new MeteoraDlmmClient(
    config.dlmmRpcUrls.map((url) => new Connection(url)),
    { endpointRegistry }
  );
  const swapProviderChain = createDefaultSwapProviderChain({
    providerOrder: config.swapProviderOrder,
    jupiterClient,
    dlmmClient,
    raydiumTradeApiUrl: config.raydiumTradeApiUrl,
    okxDexApiUrl: config.okxDexApiUrl,
    okxDexChainIndex: config.okxDexChainIndex,
    okxDexApiKey: config.okxDexApiKey,
    okxDexSecretKey: config.okxDexSecretKey,
    okxDexPassphrase: config.okxDexPassphrase,
    okxDexProjectId: config.okxDexProjectId,
    cooldownMs: config.swapProviderCooldownMs,
    noRouteTtlMs: config.jupiterNegativeRouteCacheTtlMs
  });
  const valuationProviderChain = createDefaultValuationProviderChain({
    providerOrder: config.valuationProviderOrder,
    dlmmClient,
    birdeyeApiUrl: config.birdeyeApiUrl,
    birdeyeApiKey: config.birdeyeApiKey,
    jupiterPriceApiUrl: config.jupiterPriceApiUrl,
    dexscreenerApiUrl: config.dexscreenerApiUrl,
    geckoterminalApiUrl: config.geckoterminalApiUrl,
    cooldownMs: config.valuationProviderCooldownMs,
    negativeCacheTtlMs: config.valuationProviderNegativeCacheTtlMs
  });

  const server = createSolanaExecutionServer({
    host: config.host,
    port: config.port,
    executionMode: config.executionMode,
    stateRootDir: config.stateRootDir,
    keypair,
    rpcClient,
    jupiterClient,
    dlmmClient,
    swapProviderChain,
    valuationProviderChain,
    authToken: config.authToken,
    expectedSignerPublicKeys: config.expectedSignerPublicKeys,
    maxOutputSol: config.maxOutputSol,
    defaultSlippageBps: config.defaultSlippageBps,
    residualTokenMinValueSol: config.residualTokenMinValueSol,
    residualTokenDustMaxUiAmount: config.residualTokenDustMaxUiAmount,
    broadcastPolicy: config.broadcastPolicy,
    jitoTipLamports: config.jitoTipLamports,
    dryRun: config.dryRun,
    dryRunAddLpRebuildOnBinSlippage: config.dryRunAddLpRebuildOnBinSlippage,
    dryRunAddLpRebuildMaxAttempts: config.dryRunAddLpRebuildMaxAttempts,
    addLpBinSlippageCooldownMs: config.addLpBinSlippageCooldownMs
  });

  await server.start();
  process.stdout.write(`solana-execution listening on ${server.origin}\n`);
  void dlmmClient.warmPositionSnapshots(keypair.publicKey).then(() => {
    process.stdout.write(`DLMM position snapshots warmed for ${keypair.publicKey.toBase58()}\n`);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`DLMM position snapshot warmup failed: ${message}\n`);
  });

  const stop = async () => {
    await server.stop();
    process.exitCode = 0;
  };

  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
