import { join } from 'node:path';
import { AnalyticsServer } from '../analytics/analytics-server.ts';

async function main() {
  console.log('Starting Portfolio Analytics Server...');

  const host = process.env.ANALYTICS_HOST || '0.0.0.0';
  const port = Number(process.env.ANALYTICS_PORT) || 4000;
  const strategyId = process.env.STRATEGY_ID || 'new-token-v1';
  const authToken = process.env.ANALYTICS_AUTH_TOKEN;

  const server = new AnalyticsServer({
    host,
    port,
    strategyId,
    authToken,
    journalRootDir: join(process.cwd(), 'tmp', 'journals')
  });

  const stop = async () => {
    console.log('\nShutting down Analytics Server...');
    await server.stop();
    console.log('Analytics Server stopped.');
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await server.start();
  } catch (err) {
    console.error('Failed to start Analytics Server:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled fatal error in run-analytics-server-main:', err);
  process.exit(1);
});
