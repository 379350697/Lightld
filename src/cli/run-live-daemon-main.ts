import { join } from 'node:path';

import { HttpLiveBroadcaster } from '../execution/http-live-broadcaster.ts';
import { HttpLiveConfirmationProvider } from '../execution/http-live-confirmation-provider.ts';
import { HttpLiveQuoteProvider } from '../execution/http-live-quote-provider.ts';
import { HttpLiveSigner } from '../execution/http-live-signer.ts';
import { loadMirrorConfig } from '../observability/mirror-config.ts';
import { createMirrorRuntime } from '../observability/mirror-runtime.ts';
import { HttpAlertSink } from '../runtime/http-alert-sink.ts';
import { buildLiveCycleInputFromIngest } from '../runtime/ingest-context-builder.ts';
import { HttpLiveAccountStateProvider } from '../runtime/live-account-provider.ts';
import { runLiveDaemon } from '../runtime/live-daemon.ts';
import { loadLiveRuntimeConfig } from '../runtime/live-runtime-config.ts';
import { SignalStore } from '../runtime/signal-store.ts';

type ParsedArgs = {
  strategy?: string;
  stateRootDir: string;
  journalRootDir: string;
  tickIntervalMs: number;
  maxTicks?: number;
  requestedPositionSol?: number;
  whitelist: string[];
  traderWallet?: string;
  meteoraPageSize?: number;
  meteoraQuery?: string;
  meteoraSortBy?: string;
  meteoraFilterBy?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    stateRootDir: process.env.LIVE_STATE_DIR ?? 'state',
    journalRootDir: process.env.LIVE_JOURNAL_DIR ?? 'tmp/journals',
    tickIntervalMs: Number(process.env.LIVE_DAEMON_TICK_INTERVAL_MS ?? 30_000),
    requestedPositionSol: process.env.LIVE_REQUESTED_POSITION_SOL
      ? Number(process.env.LIVE_REQUESTED_POSITION_SOL)
      : undefined,
    whitelist: (process.env.LIVE_WHITELIST ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    traderWallet: process.env.LIVE_TRADER_WALLET,
    meteoraPageSize: process.env.LIVE_METEORA_PAGE_SIZE
      ? Number(process.env.LIVE_METEORA_PAGE_SIZE)
      : undefined,
    meteoraQuery: process.env.LIVE_METEORA_QUERY,
    meteoraSortBy: process.env.LIVE_METEORA_SORT_BY,
    meteoraFilterBy: process.env.LIVE_METEORA_FILTER_BY
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--strategy' && next) {
      parsed.strategy = next;
      index += 1;
      continue;
    }

    if (current === '--state-root-dir' && next) {
      parsed.stateRootDir = next;
      index += 1;
      continue;
    }

    if (current === '--journal-root-dir' && next) {
      parsed.journalRootDir = next;
      index += 1;
      continue;
    }

    if (current === '--tick-interval-ms' && next) {
      parsed.tickIntervalMs = Number(next);
      index += 1;
      continue;
    }

    if (current === '--max-ticks' && next) {
      parsed.maxTicks = Number(next);
      index += 1;
      continue;
    }

    if (current === '--requested-position-sol' && next) {
      parsed.requestedPositionSol = Number(next);
      index += 1;
      continue;
    }

    if (current === '--whitelist' && next) {
      parsed.whitelist = next
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (current === '--trader-wallet' && next) {
      parsed.traderWallet = next;
      index += 1;
      continue;
    }

    if (current === '--meteora-page-size' && next) {
      parsed.meteoraPageSize = Number(next);
      index += 1;
      continue;
    }

    if (current === '--meteora-query' && next) {
      parsed.meteoraQuery = next;
      index += 1;
      continue;
    }

    if (current === '--meteora-sort-by' && next) {
      parsed.meteoraSortBy = next;
      index += 1;
      continue;
    }

    if (current === '--meteora-filter-by' && next) {
      parsed.meteoraFilterBy = next;
      index += 1;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeConfig = loadLiveRuntimeConfig();
  const mirrorConfig = loadMirrorConfig({
    ...process.env,
    LIVE_STATE_DIR: args.stateRootDir,
    LIVE_DB_MIRROR_PATH: process.env.LIVE_DB_MIRROR_PATH ?? join(args.stateRootDir, 'lightld-observability.sqlite')
  });

  if (args.strategy !== 'new-token-v1' && args.strategy !== 'large-pool-v1') {
    throw new Error('Expected --strategy to be one of: new-token-v1, large-pool-v1');
  }

  const strategy = args.strategy;

  const executionAdapters = runtimeConfig.executionMode === 'http'
    ? {
        quoteProvider: new HttpLiveQuoteProvider({
          url: runtimeConfig.quoteServiceUrl,
          authToken: runtimeConfig.authToken
        }),
        signer: new HttpLiveSigner({
          url: runtimeConfig.signServiceUrl,
          authToken: runtimeConfig.authToken
        }),
        broadcaster: new HttpLiveBroadcaster({
          url: runtimeConfig.broadcastServiceUrl,
          authToken: runtimeConfig.authToken
        }),
        confirmationProvider: new HttpLiveConfirmationProvider({
          url: runtimeConfig.confirmationServiceUrl,
          authToken: runtimeConfig.authToken
        }),
        accountProvider: new HttpLiveAccountStateProvider({
          url: runtimeConfig.accountStateUrl,
          authToken: runtimeConfig.authToken
        })
      }
    : {};
  const alertSink = process.env.LIVE_ALERT_WEBHOOK_URL
    ? new HttpAlertSink({
        url: process.env.LIVE_ALERT_WEBHOOK_URL,
        authToken: process.env.LIVE_ALERT_AUTH_TOKEN
      })
    : undefined;
  const mirrorRuntime = mirrorConfig.enabled
    ? createMirrorRuntime({ config: mirrorConfig })
    : undefined;

  await runLiveDaemon({
    strategy,
    stateRootDir: args.stateRootDir,
    journalRootDir: args.journalRootDir,
    tickIntervalMs: args.tickIntervalMs,
    maxTicks: args.maxTicks,
    mirrorRuntime,
    buildCycleInput: async () => {
      const accountState = executionAdapters.accountProvider
        ? await executionAdapters.accountProvider.readState()
        : undefined;

      return {
        ...executionAdapters,
        accountState,
        spendingLimitsConfig:
          runtimeConfig.maxSingleOrderSol || runtimeConfig.maxDailySpendSol
            ? {
                maxSingleOrderSol: runtimeConfig.maxSingleOrderSol ?? Number.POSITIVE_INFINITY,
                maxDailySpendSol: runtimeConfig.maxDailySpendSol ?? Number.POSITIVE_INFINITY
              }
            : undefined,
        ...(await (async () => {
          let dynamicWhitelist = [...args.whitelist];
          const activePositions = accountState ? (accountState.walletTokens || []).filter(t => t.amount > 0 && t.mint !== 'So11111111111111111111111111111111111111112') : [];
          
          const maxPositions = 5;
          const currentMinute = new Date().getMinutes();
          const isTriggerWindow = currentMinute === 0 || currentMinute === 30;

          if (activePositions.length < maxPositions && isTriggerWindow) {
            const signalStore = new SignalStore();
            const pending = signalStore.getPendingSignals();
            
            // 1. 30-Minute Maturation survival test
            const nowMs = Date.now();
            const matured = pending.filter(s => (nowMs - new Date(s.discoveredAt).getTime()) >= 30 * 60 * 1000);

            if (matured.length > 0) {
              // 2. Real-time Market Validation
              const { DexScreenerClient } = await import('../ingest/dexscreener/client.ts');
              const dexClient = new DexScreenerClient();
              // Batch limit is 30. We take the oldest matured ones to check
              const fetched = await dexClient.getTokensData(matured.map(m => m.tokenMint).slice(0, 30));
              
              const requireTvl = Number(process.env.SCANNER_MIN_TVL_USD || '5000');
              const requireVol = Number(process.env.SCANNER_MIN_VOL_USD || '1000000');
              const requireMcap = Number(process.env.SCANNER_MIN_MCAP_USD || '150000');

              const stillValid = matured.filter(s => {
                const pair = fetched.find(p => p.baseToken?.address === s.tokenMint);
                if (!pair) return false;
                const tvl = pair.liquidity?.usd ?? 0;
                const vol24 = pair.volume?.h24 ?? 0;
                const mcap = pair.marketCap ?? pair.fdv ?? 0;
                
                return tvl >= requireTvl && vol24 >= requireVol && mcap >= requireMcap;
              });

              if (stillValid.length > 0) {
                // 3. Pick the absolute best real-time TVL from survivors
                stillValid.sort((a, b) => {
                  const tvlA = fetched.find(p => p.baseToken?.address === a.tokenMint)?.liquidity?.usd ?? 0;
                  const tvlB = fetched.find(p => p.baseToken?.address === b.tokenMint)?.liquidity?.usd ?? 0;
                  return tvlB - tvlA;
                });
                
                const nextSignal = stillValid[0];
                if (nextSignal.tokenSymbol && nextSignal.tokenSymbol !== 'UNKNOWN') {
                  dynamicWhitelist.push(nextSignal.tokenSymbol);
                  signalStore.updateSignalStatus(nextSignal.id, 'processing');
                  console.log(`\n[Daemon] 🎯 DISPATCHED! Selected ${nextSignal.tokenSymbol} after 30-min survival. Real-time TVL: Highest in queue.`);
                }
              }
            }
          }

          return buildLiveCycleInputFromIngest({
            strategy,
            whitelist: dynamicWhitelist,
            traderWallet: args.traderWallet,
          requestedPositionSol: args.requestedPositionSol,
          accountState,
          meteoraPageSize: args.meteoraPageSize,
          meteoraQuery: args.meteoraQuery,
          meteoraSortBy: args.meteoraSortBy,
          meteoraFilterBy: args.meteoraFilterBy
        }))
      };
    },
    alertSink
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
