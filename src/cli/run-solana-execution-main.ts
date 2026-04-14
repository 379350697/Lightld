import { Connection } from '@solana/web3.js';
import { loadSolanaExecutionConfig } from '../execution/solana/solana-execution-config.ts';
import { JupiterClient } from '../execution/solana/jupiter-client.ts';
import { SolanaRpcClient } from '../execution/solana/solana-rpc-client.ts';
import { loadSolanaKeypair } from '../execution/solana/solana-transaction-signer.ts';
import { createSolanaExecutionServer } from '../execution/solana/solana-execution-server.ts';
import { MeteoraDlmmClient } from '../execution/solana/meteora-dlmm-client.ts';

async function main() {
  const config = loadSolanaExecutionConfig();
  const keypair = await loadSolanaKeypair({
    keypairPath: config.keypairPath,
    expectedPublicKey: config.expectedPublicKey
  });

  process.stdout.write(`Wallet: ${keypair.publicKey.toBase58()}\n`);
  process.stdout.write(`Trade RPCs: ${config.writeRpcUrls.join(', ')}\n`);
  process.stdout.write(`Read RPCs: ${config.readRpcUrls.join(', ')}\n`);
  process.stdout.write(`DLMM RPC: ${config.dlmmRpcUrl}\n`);
  process.stdout.write(`Jupiter: ${config.jupiterApiUrl}\n`);

  const rpcClient = new SolanaRpcClient({
    rpcUrl: config.rpcUrl,
    writeRpcUrls: config.writeRpcUrls,
    readRpcUrls: config.readRpcUrls
  });
  const jupiterClient = new JupiterClient({
    apiUrl: config.jupiterApiUrl,
    apiKey: config.jupiterApiKey
  });

  const connection = new Connection(config.dlmmRpcUrl);
  const dlmmClient = new MeteoraDlmmClient(connection);

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
