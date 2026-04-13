import { TokenScannerDaemon } from '../scanner/token-scanner-daemon.ts';

async function main() {
  const minTvlUsd = Number(process.env.SCANNER_MIN_TVL_USD || '5000');
  const minVol24hUsd = Number(process.env.SCANNER_MIN_VOL_USD || '1000000');
  const minMarketCapUsd = Number(process.env.SCANNER_MIN_MCAP_USD || '150000');
  const maxPoolAgeMs = Number(process.env.SCANNER_MAX_AGE_HOURS || '72') * 60 * 60 * 1000;

  const requireJupiterVerification = process.env.SCANNER_REQUIRE_VERIFIED !== 'false';
  const minOrganicScore = process.env.SCANNER_MIN_ORGANIC_SCORE ? Number(process.env.SCANNER_MIN_ORGANIC_SCORE) : undefined;
  
  const pollIntervalMs = 5000; // run batch every 5s

  const daemon = new TokenScannerDaemon({
    minTvlUsd,
    minVol24hUsd,
    minMarketCapUsd,
    maxPoolAgeMs,
    requireJupiterVerification,
    minOrganicScore,
    pollIntervalMs
  });

  daemon.start();

  const stop = () => {
    console.log('[Scanner] Shutting down...');
    daemon.stop();
    process.exitCode = 0;
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // Keep process alive indefinitely
  await new Promise(() => {});
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
