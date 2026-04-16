import { Connection } from '@solana/web3.js';
import { loadSolanaExecutionConfig } from '../execution/solana/solana-execution-config.ts';
import { JupiterClient } from '../execution/solana/jupiter-client.ts';
import { SolanaRpcClient } from '../execution/solana/solana-rpc-client.ts';
import { loadSolanaKeypair } from '../execution/solana/solana-transaction-signer.ts';
import { createSolanaExecutionServer } from '../execution/solana/solana-execution-server.ts';
import { MeteoraDlmmClient } from '../execution/solana/meteora-dlmm-client.ts';
import { RpcEndpointRegistry } from '../execution/rpc-endpoint-registry.ts';

async function main() {
  const config = loadSolanaExecutionConfig();
  const keypair = await loadSolanaKeypair({
    keypairPath: config.keypairPath,
    expectedPublicKey: config.expectedPublicKey
  });

  process.stdout.write(`Wallet: ${keypair.publicKey.toBase58()}\n`);
  process.stdout.write(`Trade RPCs: ${config.writeRpcUrls.join(', ')}\n`);
  process.stdout.write(`Read RPCs: ${config.readRpcUrls.join(', ')}\n`);
  process.stdout.write(`DLMM RPCs: ${config.dlmmRpcUrls.join(', ')}\n`);
  process.stdout.write(`Jupiter: ${config.jupiterApiUrl}\n`);

  const endpointRegistry = new RpcEndpointRegistry({
    rateLimitedCooldownMs: config.rpc429CooldownMs,
    timeoutCooldownMs: config.rpcTimeoutCooldownMs,
    serverErrorCooldownMs: config.rpc5xxCooldownMs,
    maxWaitMs: config.rpcEndpointMaxWaitMs
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
    endpointRegistry
  });

  const dlmmClient = new MeteoraDlmmClient(
    config.dlmmRpcUrls.map((url) => new Connection(url)),
    { endpointRegistry }
  );

  const server = createSolanaExecutionServer({
    host: config.host,
    port: config.port,
    keypair,
    rpcClient,
    jupiterClient,
    dlmmClient,
    authToken: config.authToken,
    maxOutputSol: config.maxOutputSol,
    defaultSlippageBps: config.defaultSlippageBps,
    jitoTipLamports: config.jitoTipLamports
  });

  await server.start();
  process.stdout.write(`solana-execution listening on ${server.origin}\n`);

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
