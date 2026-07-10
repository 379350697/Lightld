import { join } from 'node:path';

import { SqliteCandidatePool } from '../candidate-pool/sqlite-candidate-pool.ts';
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
import {
  initializeDaemonRunManifest,
  parseRunModeV2,
  selectRuntimeEnvironment
} from '../runtime/run-manifest-v2.ts';
import { SpendingLimitsStore, type SpendingLimitsConfig } from '../risk/spending-limits.ts';
import {
  applyRiskObservation,
  CANARY_RISK_LIMITS,
  createInitialRiskStateV2
} from '../risk/risk-policy-v2.ts';
import { RiskStateV2Store } from '../risk/risk-state-v2.ts';

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

function estimateAccountEquitySol(accountState: Awaited<ReturnType<HttpLiveAccountStateProvider['readState']>> | undefined) {
  if (!accountState) return 0;
  const tokenValue = (accountState.walletTokens ?? []).reduce(
    (sum, token) => sum + (typeof token.currentValueSol === 'number' ? token.currentValueSol : 0),
    0
  );
  const lpValue = (accountState.walletLpPositions ?? []).reduce(
    (sum, position) => sum + (typeof position.lpTotalValueSol === 'number'
      ? position.lpTotalValueSol
      : typeof position.currentValueSol === 'number'
        ? position.currentValueSol
        : 0),
    0
  );
  return Math.max(0, accountState.walletSol + tokenValue + lpValue);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    stateRootDir: process.env.LIVE_STATE_DIR ?? 'state',
    journalRootDir: process.env.LIVE_JOURNAL_DIR ?? 'tmp/journals',
    tickIntervalMs: Number(process.env.LIVE_DAEMON_TICK_INTERVAL_MS ?? 30_000),
    hotTickIntervalMs: Number(process.env.LIVE_DAEMON_HOT_TICK_INTERVAL_MS ?? 3_000),
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
      parsed.tickIntervalMs = Number(next);
      index += 1;
      continue;
    }

    if (current === '--hot-tick-interval-ms' && next) {
      parsed.hotTickIntervalMs = Number(next);
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
  const runtimeConfig = loadLiveRuntimeConfig();
  const spendingLimitsConfig = parseBoolean(process.env.LIVE_IGNORE_SPENDING_LIMITS, false)
    ? undefined
    : buildSpendingLimitsConfig({
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

  const strategy = args.strategy;
  const daemonSettings = {
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
    housekeepingIntervalMs: parsePositiveInteger(
      process.env.LIVE_HOUSEKEEPING_INTERVAL_MS,
      30 * 60_000
    ),
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
    },
    candidatePoolReadEnabled: parseBoolean(process.env.LIVE_CANDIDATE_POOL_READ_ENABLED, true),
    candidatePoolPath: process.env.LIVE_CANDIDATE_POOL_DB_PATH
      ?? join(args.stateRootDir, 'lightld-candidate-pool.sqlite'),
    candidatePoolMaxAgeMs: parsePositiveInteger(process.env.LIVE_CANDIDATE_POOL_STALE_MS, 45_000),
    openAfterMaintenanceHold: parseBoolean(
      process.env.LIVE_OPEN_AFTER_MAINTENANCE_HOLD,
      (args.maxActivePositions ?? 5) > 1
    ),
    disableDynamicPositionSizing: parseBoolean(process.env.LIVE_DISABLE_DYNAMIC_POSITION_SIZING, false),
    newCandidateSafetyMaxBatchSize: parsePositiveInteger(
      process.env.LIVE_NEW_CANDIDATE_GMGN_MAX_BATCH_SIZE,
      1
    ),
    newCandidateSafetyTimeoutMs: parseOptionalPositiveInteger(process.env.LIVE_NEW_CANDIDATE_GMGN_TIMEOUT_MS),
    ignoreLivePositionSolLimit: parseBoolean(process.env.LIVE_IGNORE_POSITION_SOL_LIMIT, false),
    ignoreSpendingLimits: parseBoolean(process.env.LIVE_IGNORE_SPENDING_LIMITS, false),
    gmgnCacheMaxEntries: parsePositiveInteger(process.env.GMGN_CACHE_MAX_ENTRIES, 5_000)
  };
  const runManifestContext = await initializeDaemonRunManifest({
    stateRootDir: args.stateRootDir,
    mode: parseRunModeV2(process.env.LIGHTLD_RUN_MODE),
    effectiveConfig: {
      strategy,
      daemon: {
        ...args,
        ...daemonSettings
      },
      runtime: runtimeConfig,
      mirror: mirrorConfig,
      spendingLimits: spendingLimitsConfig ?? null,
      environmentOverrides: selectRuntimeEnvironment(process.env)
    },
    environment: process.env,
    datasetVersion: process.env.LIGHTLD_DATASET_VERSION ?? '2',
    candidateSnapshotId: process.env.LIGHTLD_CANDIDATE_SNAPSHOT_ID ?? 'unversioned-candidate-snapshot',
    policyVariantId: process.env.LIGHTLD_POLICY_VARIANT_ID ?? 'baseline',
    worktreeRoot: process.cwd()
  });
  const riskStateV2Store = new RiskStateV2Store(args.stateRootDir);

  if (spendingLimitsConfig && runtimeConfig.resetSpendingLimitsOnStartup) {
    await new SpendingLimitsStore(args.stateRootDir).reset();
  }

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
    intervalMs: daemonSettings.housekeepingIntervalMs,
    runJournalCleanup: () =>
      cleanupRuntimeJournals({
        strategy,
        journalRootDir: args.journalRootDir,
        retentionDays: daemonSettings.retentionDays
      }),
    runMirrorPrune: async () => (await mirrorRuntime?.pruneOnce?.({ force: true }))?.deletedRows ?? 0,
    runGmgnCacheSweep: () =>
      sweepTokenSafetyCache({
        maxEntries: daemonSettings.gmgnCacheMaxEntries
      })
  });
  const evolutionPaths = resolveEvolutionPaths(strategy, join(args.stateRootDir, 'evolution'));
  const candidateScanStore = new CandidateScanStore(evolutionPaths.candidateScansPath);
  const candidatePoolReader = daemonSettings.candidatePoolReadEnabled
    ? new SqliteCandidatePool({
        path: daemonSettings.candidatePoolPath,
        readOnly: true
      })
    : undefined;

  try {
    await runLiveDaemon({
      strategy,
      stateRootDir: args.stateRootDir,
      journalRootDir: args.journalRootDir,
      tickIntervalMs: args.tickIntervalMs,
      hotTickIntervalMs: args.hotTickIntervalMs,
      residualTokenSweepIntervalMs: daemonSettings.residualTokenSweepIntervalMs,
      residualTokenSweepCooldownMs: daemonSettings.residualTokenSweepCooldownMs,
      residualTokenSweepMinValueSol: daemonSettings.residualTokenSweepMinValueSol,
      maxTicks: args.maxTicks,
      accountProvider: executionAdapters.accountProvider,
      lpEntryEvidenceProvider: executionAdapters.lpEntryEvidenceProvider,
      signer: executionAdapters.signer,
      broadcaster: executionAdapters.broadcaster,
      confirmationProvider: executionAdapters.confirmationProvider,
      mirrorRuntime,
      housekeepingRunner,
      maxActivePositions: args.maxActivePositions,
      openAfterMaintenanceHold: daemonSettings.openAfterMaintenanceHold,
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
          candidatePoolReadEnabled: daemonSettings.candidatePoolReadEnabled,
          candidatePoolMaxAgeMs: daemonSettings.candidatePoolMaxAgeMs,
          disableDynamicPositionSizing: daemonSettings.disableDynamicPositionSizing,
          newCandidateSafetyMaxBatchSize: daemonSettings.newCandidateSafetyMaxBatchSize,
          newCandidateSafetyTimeoutMs: daemonSettings.newCandidateSafetyTimeoutMs,
          positionState: buildContext?.positionState,
          selectionMode: buildContext?.selectionMode as IngestSelectionMode | undefined,
          skipMints: buildContext?.skipMints,
          openCooldowns: buildContext?.openCooldowns
        });

        return {
          ...executionAdapters,
          accountState,
          spendingLimitsConfig,
          ignoreLivePositionSolLimit: daemonSettings.ignoreLivePositionSolLimit,
          ...ingestInput,
          professionalRun: {
            runId: runManifestContext.manifest.runId,
            mode: runManifestContext.manifest.mode,
            configSnapshotId: runManifestContext.manifest.effectiveConfigSha256,
            parameterSnapshot: {
              strategy,
              requestedPositionSol: ingestInput.requestedPositionSol,
              maxActivePositions: args.maxActivePositions ?? 5
            }
          },
          ...(runManifestContext.manifest.mode === 'mechanical-soak'
            ? {}
            : {
                riskStateV2: await (async () => {
                  const now = new Date().toISOString();
                  const equitySol = estimateAccountEquitySol(accountState);
                  const existing = await riskStateV2Store.read();
                  const initial = existing ?? createInitialRiskStateV2({
                    now,
                    startOfDayEquitySol: equitySol,
                    currentEquitySol: equitySol,
                    availableSol: accountState?.walletSol ?? 0
                  });
                  const productionLike = runManifestContext.manifest.mode === 'canary'
                    || runManifestContext.manifest.mode === 'live';
                  const next = applyRiskObservation(initial, {
                    now,
                    currentEquitySol: equitySol,
                    realizedPnlSol: initial.realizedPnlSol,
                    unrealizedPnlSol: equitySol - initial.startOfDayEquitySol - initial.realizedPnlSol,
                    availableSol: accountState?.walletSol ?? 0,
                    activePositionCount: (accountState?.walletLpPositions ?? []).length,
                    dailyNewRiskSol: initial.dailyNewRiskSol,
                    dataQualityStatus: accountState ? 'trusted' : 'untrusted',
                    reconciliationStatus: productionLike ? 'pending' : 'matched',
                    outboxStatus: productionLike ? 'unknown' : 'settled',
                    valuationStatus: (accountState?.walletLpPositions ?? []).every((position) =>
                      position.valuationStatus === undefined || position.valuationStatus === 'ready'
                    ) ? 'ready' : 'degraded'
                  }, CANARY_RISK_LIMITS);
                  return riskStateV2Store.write(next);
                })(),
                riskLimitsV2: CANARY_RISK_LIMITS
              })
        };
      },
      alertSink
    });
  } finally {
    await runManifestContext.store.complete(runManifestContext.manifest.runId);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
