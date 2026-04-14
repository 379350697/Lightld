import { loadLocalLiveSignerConfig } from '../execution/local-live-signer-config.ts';
import { createLocalLiveSignerServer } from '../execution/local-live-signer-server.ts';

async function main() {
  const config = loadLocalLiveSignerConfig();
  const server = createLocalLiveSignerServer(config);

  await server.start();
  process.stdout.write(`local-live-signer listening on ${server.origin}\n`);

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
