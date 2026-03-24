import { createLocalLiveExecutionServer } from '../execution/local-live-execution-server.ts';
import { loadLocalLiveExecutionConfig } from '../execution/local-live-execution-config.ts';

async function main() {
  const config = loadLocalLiveExecutionConfig();
  const server = createLocalLiveExecutionServer(config);

  await server.start();
  process.stdout.write(`local-live-execution listening on ${server.origin}\n`);

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
