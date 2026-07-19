import { join } from 'node:path';

import { SqliteCandidatePool } from '../candidate-pool/sqlite-candidate-pool.ts';
import { loadStrategyConfig } from '../config/loader.ts';
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
import { buildLiveCycleInputFromIngest, type IngestSelectionMode } from '../runtime/ingest-context-builder.ts';
import { HttpLiveAccountStateProvider } from '../runtime/live-account-provider.ts';
import { deriveLpEntryEvidenceUrl, HttpLpEntryEvidenceProvider } from '../runtime/lp-entry-evidence-provider.ts';
import { runLiveDaemon } from '../runtime/live-daemon.ts';
import { loadLiveRuntimeConfig } from '../runtime/live-runtime-config.ts';
import type { SpendingLimitsConfig } from '../risk/spending-limits.ts';
import { StrategyResearchStore } from '../strategy-research/store.ts';
import { resolveCandidatePoolStaleMs } from './run-candidate-worker-args.ts';
import { resolveLiveDaemonTiming } from './run-live-daemon-args.ts';

type ParsedArgs = {
  strategy?: string;
  stateRootDir: string;
  journalRootDir: string;
  tickIntervalMs: number;
  hotTickIntervalMs: number;
  maxTicks?: number;
  requestedPositionSol?: number;
  traderWallet?: string;
  meteoraPageSize?: number;
  meteoraQuery?: string;
  meteoraSortBy?: string;
  meteoraFilterBy?: string;
  maxActivePositions?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const timing = resolveLiveDaemonTiming(argv);
  const parsed: ParsedArgs = {
    stateRootDir: process.env.LIVE_STATE_DIR ?? 'state',
    journalRootDir: process.env.LIVE_JOURNAL_DIR ?? 'tmp/journals',
    tickIntervalMs: timing.tickIntervalMs,
    hotTickIntervalMs: timing.hotTickIntervalMs,
    requestedPositionSol: process.env.LIVE_REQUESTED_POSITION_SOL
      ? Number(process.env.LIVE_REQUESTED_POSITION_SOL)
      : undefined,
    traderWallet: process.env.LIVE_TRADER_WALLET,
    meteoraPageSize: process.env.LIVE_METEORA_PAGE_SIZE
      ? Number(process.env.LIVE_METEORA_PAGE_SIZE)
      : undefined,
    meteoraQuery: process.env.LIVE_METEORA_QUERY,
    meteoraSortBy: process.env.LIVE_METEORA_SORT_BY,
    meteoraFilterBy: process.env.LIVE_METEORA_FILTER_BY,
    maxActivePositions: process.env.LIVE_MAX_ACTIVE_POSITIONS
      ? Number(process.env.LIVE_MAX_ACTIVE_POSITIONS)
      : undefined
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
      index += 1;
      continue;
    }

    if (current === '--hot-tick-interval-ms' && next) {
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
      continue;
    }

    if (current === '--max-active-positions' && next) {
      parsed.maxActivePositions = Number(next);
      index += 1;
    }
  }

  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.length === 0) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  return fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSpendingLimitsConfig(input: {
  maxSingleOrderSol?: number;
  maxDailySpendSol?: number;
  maxHourlySpendSol?: number;
}): SpendingLimitsConfig | undefined {
  if (!input.maxSingleOrderSol && !input.maxDailySpendSol && !input.maxHourlySpendSol) {
    return undefined;
  }

  return {
    maxSingleOrderSol: input.maxSingleOrderSol ?? Number.POSITIVE_INFINITY,
    maxDailySpendSol: input.maxDailySpendSol ?? Number.POSITIVE_INFINITY,
    maxHourlySpendSol: input.maxHourlySpendSol
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runMode = process.env.LIGHTLD_RUN_MODE;
  if (runMode !== 'live' && runMode !== 'mechanical-soak' && runMode !== 'economic-shadow') {
    throw new Error('LIGHTLD_RUN_MODE must be explicitly set to live, mechanical-soak, or economic-shadow');
  }
  if (runMode === 'live' && process.env.LIGHTLD_LIVE_CONFIRM !== 'I_UNDERSTAND_MAINNET') {
    throw new Error('Live mode requires LIGHTLD_LIVE_CONFIRM=I_UNDERSTAND_MAINNET');
  }
  const executionMode = process.env.LIGHTLD_EXECUTION_MODE;
  if (executionMode !== runMode) {
    throw new Error(`LIGHTLD_EXECUTION_MODE must match LIGHTLD_RUN_MODE (${runMode})`);
  }
  const executionDryRun = parseBoolean(process.env.SOLANA_EXECUTION_DRY_RUN, false);
  if (runMode === 'live' && executionDryRun) {
    throw new Error('Live mode cannot run with SOLANA_EXECUTION_DRY_RUN=true');
  }
  if (runMode !== 'live' && !executionDryRun) {
    throw new Error(`${runMode} requires SOLANA_EXECUTION_DRY_RUN=true`);
  }
  const runtimeConfig = loadLiveRuntimeConfig();
  if (runtimeConfig.executionMode !== 'http') {
    throw new Error('run:daemon requires LIVE_EXECUTION_MODE=http so paper and live both use the signed execution path');
  }
  const spendingLimitsConfig = buildSpendingLimitsConfig({
    maxSingleOrderSol: runtimeConfig.maxSingleOrderSol,
    maxDailySpendSol: runtimeConfig.maxDailySpendSol,
    maxHourlySpendSol: runtimeConfig.maxHourlySpendSol
  });
  const mirrorConfig = loadMirrorConfig({
    ...process.env,
    LIVE_STATE_DIR: args.stateRootDir,
    LIVE_DB_MIRROR_PATH: process.env.LIVE_DB_MIRROR_PATH ?? join(args.stateRootDir, 'lightld-observability.sqlite')
  });

  if (args.strategy !== 'new-token-v1' && args.strategy !== 'large-pool-v1') {
    throw new Error('Expected --strategy to be one of: new-token-v1, large-pool-v1');
  }
  const loadedStrategyConfig = await loadStrategyConfig(
    args.strategy === 'new-token-v1'
      ? 'src/config/strategies/new-token-v1.yaml'
      : 'src/config/strategies/large-pool-v1.yaml'
  );
  const paperMaxLivePositionSol = runMode === 'mechanical-soak'
    ? parsePositiveNumber(
        process.env.LIVE_PAPER_MAX_LIVE_POSITION_SOL,
        loadedStrategyConfig.live.maxLivePositionSol
      )
    : loadedStrategyConfig.live.maxLivePositionSol;
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
          authToken: runtimeConfig.authToken,
          timeoutMs: runtimeConfig.accountStateTimeoutMs
        }),
        lpEntryEvidenceProvider: new HttpLpEntryEvidenceProvider({
          url: deriveLpEntryEvidenceUrl(runtimeConfig.accountStateUrl),
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
  const candidatePoolReadEnabled = parseBoolean(process.env.LIVE_CANDIDATE_POOL_READ_ENABLED, true);
  const openAfterMaintenanceHold = parseBoolean(
    process.env.LIVE_OPEN_AFTER_MAINTENANCE_HOLD,
    (args.maxActivePositions ?? 5) > 1
  );
  const candidatePoolReader = candidatePoolReadEnabled
    ? new SqliteCandidatePool({
        path: process.env.LIVE_CANDIDATE_POOL_DB_PATH ?? join(args.stateRootDir, 'lightld-candidate-pool.sqlite'),
        readOnly: true
      })
    : undefined;

  const researchStoreCandidate = runMode === 'live'
    ? undefined
    : new StrategyResearchStore(join(args.stateRootDir, 'research', 'research.sqlite'));
  const researchStore = researchStoreCandidate && await researchStoreCandidate.openBestEffort(console)
    ? researchStoreCandidate
    : undefined;
  try {
    await runLiveDaemon({
    strategy,
      captureMode: runMode,
      spendingLimitsConfig,
      stateRootDir: args.stateRootDir,
    journalRootDir: args.journalRootDir,
    tickIntervalMs: args.tickIntervalMs,
    hotTickIntervalMs: args.hotTickIntervalMs,
    residualTokenSweepIntervalMs: parsePositiveInteger(
      process.env.LIVE_RESIDUAL_TOKEN_SWEEP_INTERVAL_MS,
      5 * 60_000
    ),
    residualTokenSweepCooldownMs: parsePositiveInteger(
      process.env.LIVE_RESIDUAL_TOKEN_SWEEP_COOLDOWN_MS,
      30 * 60_000
    ),
    residualTokenSweepMinValueSol: parsePositiveNumber(
      process.env.LIVE_RESIDUAL_TOKEN_SWEEP_MIN_VALUE_SOL,
      0.1
    ),
    residualSweepMaxSlippageBps: loadedStrategyConfig.solRouteLimits.maxSlippageBps,
    residualSweepMaxImpactBps: loadedStrategyConfig.solRouteLimits.maxImpactBps,
    maxTicks: args.maxTicks,
    accountProvider: executionAdapters.accountProvider,
    lpEntryEvidenceProvider: executionAdapters.lpEntryEvidenceProvider,
    signer: executionAdapters.signer,
    broadcaster: executionAdapters.broadcaster,
    confirmationProvider: executionAdapters.confirmationProvider,
    mirrorRuntime,
    housekeepingRunner,
    maxActivePositions: args.maxActivePositions,
    openAfterMaintenanceHold,
    buildCycleInput: async (_tickCount, buildContext) => {
      const accountState = buildContext?.accountState ?? (executionAdapters.accountProvider
        ? await executionAdapters.accountProvider.readState()
        : undefined);

      const ingestInput = await buildLiveCycleInputFromIngest({
        strategy,
        traderWallet: args.traderWallet,
        requestedPositionSol: args.requestedPositionSol,
        candidateScanSink: candidateScanStore,
        accountState,
        meteoraPageSize: args.meteoraPageSize,
        meteoraQuery: args.meteoraQuery,
        meteoraSortBy: args.meteoraSortBy,
        meteoraFilterBy: args.meteoraFilterBy,
        maxActivePositions: args.maxActivePositions,
        candidatePoolReader,
        candidatePoolReadEnabled,
        candidatePoolMaxAgeMs: resolveCandidatePoolStaleMs(process.env),
        disableDynamicPositionSizing: parseBoolean(process.env.LIVE_DISABLE_DYNAMIC_POSITION_SIZING, false),
        newCandidateSafetyMaxBatchSize: parsePositiveInteger(process.env.LIVE_NEW_CANDIDATE_GMGN_MAX_BATCH_SIZE, 1),
        newCandidateSafetyTimeoutMs: parseOptionalPositiveInteger(process.env.LIVE_NEW_CANDIDATE_GMGN_TIMEOUT_MS),
        positionState: buildContext?.positionState,
        positionLedger: buildContext?.positionLedger,
        selectionMode: buildContext?.selectionMode as IngestSelectionMode | undefined,
        skipMints: buildContext?.skipMints,
        openCooldowns: buildContext?.openCooldowns
      });

      return {
        ...executionAdapters,
        captureMode: runMode,
        maxLivePositionSolOverride: runMode === 'mechanical-soak'
          ? paperMaxLivePositionSol
          : undefined,
        accountState,
        spendingLimitsConfig,
        ...ingestInput
      };
    },
      onCycleResult: researchStore ? (result) => {
        if ((result.action !== 'deploy' && result.action !== 'add-lp') || !result.liveOrderSubmitted) return;
        const poolAddress = typeof result.context?.pool?.address === 'string' ? result.context.pool.address : '';
        const tokenMint = typeof result.context?.token?.mint === 'string' ? result.context.token.mint : '';
        if (!poolAddress || !tokenMint) return;
        researchStore.recordPaperSelection({
          strategyId: strategy,
          poolAddress,
          tokenMint,
          selectedAt: result.orderIntent?.createdAt ?? new Date().toISOString(),
          action: result.action,
          reason: result.reason
        });
      } : undefined,
      alertSink
    });
  } finally {
    researchStore?.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
