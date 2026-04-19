import { join } from 'node:path';

import { HttpLiveBroadcaster } from '../execution/http-live-broadcaster.ts';
import { HttpLiveConfirmationProvider } from '../execution/http-live-confirmation-provider.ts';
import { HttpLiveQuoteProvider } from '../execution/http-live-quote-provider.ts';
import { HttpLiveSigner } from '../execution/http-live-signer.ts';
import { loadMirrorConfig } from '../observability/mirror-config.ts';
import { createMirrorRuntime } from '../observability/mirror-runtime.ts';
import { CandidateScanStore, resolveEvolutionPaths } from '../evolution/index.ts';
import { HttpAlertSink } from '../runtime/http-alert-sink.ts';
import { sweepTokenSafetyCache } from '../ingest/gmgn/token-safety-client.ts';
import {
  cleanupRuntimeJournals,
  createHousekeepingRunner,
  DEFAULT_JOURNAL_RETENTION_DAYS
} from '../runtime/housekeeping.ts';
import { buildLiveCycleInputFromIngest } from '../runtime/ingest-context-builder.ts';
import { HttpLiveAccountStateProvider } from '../runtime/live-account-provider.ts';
import { runLiveDaemon } from '../runtime/live-daemon.ts';
import { loadLiveRuntimeConfig } from '../runtime/live-runtime-config.ts';

type ParsedArgs = {
  strategy?: string;
  stateRootDir: string;
  journalRootDir: string;
  tickIntervalMs: number;
  maxTicks?: number;
  requestedPositionSol?: number;
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

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
          authToken: runtimeConfig.authToken,
          timeoutMs: runtimeConfig.broadcastTimeoutMs
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
  const housekeepingRunner = createHousekeepingRunner({
    intervalMs: parsePositiveInteger(process.env.LIVE_HOUSEKEEPING_INTERVAL_MS, 30 * 60_000),
    runJournalCleanup: () =>
      cleanupRuntimeJournals({
        strategy,
        journalRootDir: args.journalRootDir,
        retentionDays: {
          decisionAudit: parsePositiveInteger(
            process.env.LIVE_DECISION_AUDIT_RETENTION_DAYS,
            DEFAULT_JOURNAL_RETENTION_DAYS.decisionAudit
          ),
          quotes: parsePositiveInteger(
            process.env.LIVE_QUOTES_RETENTION_DAYS,
            DEFAULT_JOURNAL_RETENTION_DAYS.quotes
          ),
          orders: parsePositiveInteger(
            process.env.LIVE_ORDER_RETENTION_DAYS,
            DEFAULT_JOURNAL_RETENTION_DAYS.orders
          ),
          fills: parsePositiveInteger(
            process.env.LIVE_FILL_RETENTION_DAYS,
            DEFAULT_JOURNAL_RETENTION_DAYS.fills
          ),
          incidents: parsePositiveInteger(
            process.env.LIVE_INCIDENT_RETENTION_DAYS,
            DEFAULT_JOURNAL_RETENTION_DAYS.incidents
          )
        }
      }),
    runMirrorPrune: async () => (await mirrorRuntime?.pruneOnce?.({ force: true }))?.deletedRows ?? 0,
    runGmgnCacheSweep: () =>
      sweepTokenSafetyCache({
        maxEntries: parsePositiveInteger(process.env.GMGN_CACHE_MAX_ENTRIES, 5_000)
      })
  });
  const evolutionPaths = resolveEvolutionPaths(strategy, join(args.stateRootDir, 'evolution'));
  const candidateScanStore = new CandidateScanStore(evolutionPaths.candidateScansPath);

  await runLiveDaemon({
    strategy,
    stateRootDir: args.stateRootDir,
    journalRootDir: args.journalRootDir,
    tickIntervalMs: args.tickIntervalMs,
    maxTicks: args.maxTicks,
    accountProvider: executionAdapters.accountProvider,
    confirmationProvider: executionAdapters.confirmationProvider,
    mirrorRuntime,
    housekeepingRunner,
    buildCycleInput: async () => {
      const accountState = executionAdapters.accountProvider
        ? await executionAdapters.accountProvider.readState()
        : undefined;

      const ingestInput = await buildLiveCycleInputFromIngest({
        strategy,
        traderWallet: args.traderWallet,
        requestedPositionSol: args.requestedPositionSol,
        candidateScanSink: candidateScanStore,
        accountState,
        meteoraPageSize: args.meteoraPageSize,
        meteoraQuery: args.meteoraQuery,
        meteoraSortBy: args.meteoraSortBy,
        meteoraFilterBy: args.meteoraFilterBy
      });

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
        ...ingestInput
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
