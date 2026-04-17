import { createDependencyHealthSnapshot, markDependencyFailure, markDependencySuccess } from './dependency-health.ts';
import { buildHealthReport } from './health-report.ts';
import { enqueueMirrorCatchupFromJournals } from '../observability/mirror-catchup.ts';
import type { MirrorRuntime } from '../observability/mirror-runtime.ts';
import { PendingSubmissionStore } from './pending-submission-store.ts';
import { RuntimeStateStore } from './runtime-state-store.ts';
import { deriveRuntimeMode } from './runtime-mode-policy.ts';
import { runLiveCycle, type LiveCycleInput, type StrategyId } from './live-cycle.ts';
import { recoverPendingSubmission } from './pending-submission-recovery.ts';
import type { PositionLifecycleState, RuntimeMode } from './state-types.ts';
import { isExposureReducingAction } from './action-semantics.ts';
import type { LiveAccountState } from './live-account-provider.ts';
import type { HousekeepingRunner } from './housekeeping.ts';
import type { AlertSink } from './alert-sink.ts';
import { NoopAlertSink, shouldSendAlert } from './alert-sink.ts';
import { ExecutionRequestError } from '../execution/error-classification.ts';

type LiveDaemonOptions = {
  strategy: StrategyId;
  stateRootDir?: string;
  journalRootDir?: string;
  tickIntervalMs?: number;
  maxTicks?: number;
  buildCycleInput?: (tickCount: number) => Promise<Omit<LiveCycleInput, 'strategy'>> | Omit<LiveCycleInput, 'strategy'>;
  alertSink?: AlertSink;
  mirrorRuntime?: MirrorRuntime;
  housekeepingRunner?: HousekeepingRunner;
};

async function resolveEffectiveAccountState(cycleInput: Omit<LiveCycleInput, 'strategy'> | undefined) {
  if (cycleInput?.accountState) {
    return cycleInput.accountState;
  }

  if (cycleInput?.accountProvider) {
    return cycleInput.accountProvider.readState();
  }

  return undefined;
}

function nowIso() {
  return new Date().toISOString();
}

function wait(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function applyDerivedRuntimeState(input: {
  currentState: {
    mode: RuntimeMode;
    circuitReason: string;
    cooldownUntil: string;
    lastHealthyAt: string;
    updatedAt: string;
  };
  derived: ReturnType<typeof deriveRuntimeMode>;
  pendingSubmission: boolean;
  now: string;
}) {
  const shouldKeepCooldown = input.pendingSubmission || input.derived.mode === 'circuit_open';

  return {
    mode: input.derived.mode,
    circuitReason: input.derived.reason === 'healthy' ? '' : input.derived.reason,
    cooldownUntil:
      input.derived.mode === 'circuit_open'
        ? new Date(Date.now() + 5 * 60_000).toISOString()
        : shouldKeepCooldown
          ? input.currentState.cooldownUntil
          : '',
    lastHealthyAt:
      input.derived.mode === 'healthy'
        ? input.now
        : input.currentState.lastHealthyAt,
    updatedAt: input.now
  };
}

function hasOpenInventory(accountState?: LiveAccountState) {
  return Boolean(
    accountState?.walletTokens?.some((token) => token.amount > 0
      && token.mint !== 'So11111111111111111111111111111111111111112'
      && token.mint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') ||
    accountState?.walletLpPositions?.some((position) =>
      (position.hasLiquidity ?? true)
      &&
      position.mint !== 'So11111111111111111111111111111111111111112'
      && position.mint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  );
}

function resolveLifecycleStateForPersist(input: {
  nextLifecycleState?: PositionLifecycleState;
  previousLifecycleState?: PositionLifecycleState;
  pendingSubmission: boolean;
  accountState?: LiveAccountState;
  lastAction?: string;
  lastReason?: string;
  activeMint?: string;
}): PositionLifecycleState {
  if (input.nextLifecycleState) {
    return input.nextLifecycleState;
  }

  const hasInventory = hasOpenInventory(input.accountState);
  const unresolvedOpen = Boolean(input.activeMint) && (
    input.lastReason?.includes('journal-open-unresolved') ||
    input.lastReason?.includes('pending-open:') ||
    input.lastReason?.includes('mint-position-already-active:')
  );
  const lastReason = input.lastReason ?? '';
  const historicalOnly = lastReason.includes('historical-unconfirmed-entry-only') ||
    lastReason.includes('historical-confirmed-entry-only');
  const pendingOpen = input.pendingSubmission && !hasInventory && (
    input.previousLifecycleState === 'open_pending' ||
    input.lastAction === 'add-lp' ||
    input.lastAction === 'deploy' ||
    unresolvedOpen
  );

  if (!input.pendingSubmission && !hasInventory) {
    return 'closed';
  }

  if (historicalOnly) {
    return 'closed';
  }

  if (pendingOpen) {
    return 'open_pending';
  }

  if (unresolvedOpen && (input.pendingSubmission || hasInventory)) {
    return 'open';
  }

  if (hasInventory) {
    return 'open';
  }

  return input.previousLifecycleState ?? 'closed';
}

export async function runLiveDaemon(options: LiveDaemonOptions) {
  const stateRootDir = options.stateRootDir ?? 'state';
  const journalRootDir = options.journalRootDir ?? 'tmp/journals';
  const tickIntervalMs = options.tickIntervalMs ?? 30_000;
  const maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY;
  const buildCycleInput:
    (tickCount: number) => Promise<Omit<LiveCycleInput, 'strategy'>> | Omit<LiveCycleInput, 'strategy'> =
      options.buildCycleInput ?? (() => ({} as Omit<LiveCycleInput, 'strategy'>));
  const alertSink = options.alertSink ?? new NoopAlertSink();
  const mirrorRuntime = options.mirrorRuntime;
  const housekeepingRunner = options.housekeepingRunner;

  const runtimeStateStore = new RuntimeStateStore(stateRootDir);
  const pendingSubmissionStore = new PendingSubmissionStore(stateRootDir);
  let dependencyHealth =
    (await runtimeStateStore.readDependencyHealth()) ?? createDependencyHealthSnapshot();
  let runtimeState = (await runtimeStateStore.readRuntimeState()) ?? {
    mode: 'healthy' as RuntimeMode,
    circuitReason: '',
    cooldownUntil: '',
    lastHealthyAt: '',
    updatedAt: nowIso()
  };
  let tickCount = 0;

  await mirrorRuntime?.start();

  try {
    while (tickCount < maxTicks) {
      tickCount += 1;
      let cycleInput: Omit<LiveCycleInput, 'strategy'> | undefined;
      let effectiveAccountState: LiveAccountState | undefined;
      let pendingSubmission = await pendingSubmissionStore.read();
      let positionState = await runtimeStateStore.readPositionState() ?? undefined;
      const cooldownActive = pendingSubmission !== null && runtimeState.cooldownUntil !== '' && runtimeState.cooldownUntil > nowIso();
      const derived = deriveRuntimeMode({
        currentMode: runtimeState.mode,
        quoteFailures: dependencyHealth.quote.consecutiveFailures,
        reconcileFailures: dependencyHealth.account.consecutiveFailures,
        hasUnknownSubmissionOutcome: pendingSubmission?.confirmationStatus === 'unknown',
        cooldownActive,
        flattenOnlyRequested: runtimeState.mode === 'flatten_only'
      });
      const previousMode = runtimeState.mode;

      const hasPendingSubmission = pendingSubmission !== null;
      runtimeState = applyDerivedRuntimeState({
        currentState: runtimeState,
        derived,
        pendingSubmission: hasPendingSubmission,
        now: nowIso()
      });

      try {
        cycleInput = await buildCycleInput(tickCount);
        effectiveAccountState = await resolveEffectiveAccountState(cycleInput);
        pendingSubmission = await pendingSubmissionStore.read();
        positionState = await runtimeStateStore.readPositionState() ?? undefined;
        let runtimeStateExplicitlySet = false;

        const result = await runLiveCycle({
          strategy: options.strategy,
          journalRootDir,
          stateRootDir,
          runtimeMode: runtimeState.mode,
          mirrorSink: mirrorRuntime,
          positionState,
          ...cycleInput,
          accountState: effectiveAccountState
        });

        if (result.failureKind && result.failureSource) {
          const dependencyKey = result.failureSource === 'broadcast'
            ? 'broadcaster'
            : result.failureSource === 'signer'
              ? 'signer'
              : result.failureSource === 'confirmation'
                ? 'confirmation'
                : result.failureSource === 'account'
                  ? 'account'
                  : result.failureSource === 'quote'
                    ? 'quote'
                    : null;

          if (dependencyKey) {
            dependencyHealth = markDependencyFailure(
              dependencyHealth,
              dependencyKey,
              result.reason,
              nowIso()
            );
          }

          if (result.failureKind === 'unknown') {
            runtimeState = {
              ...runtimeState,
              mode: 'circuit_open',
              circuitReason: result.reason,
              cooldownUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
              updatedAt: nowIso()
            };
            runtimeStateExplicitlySet = true;
          }
        }

        if (result.failureSource === 'recovery') {
          const hasPendingSubmission = (await pendingSubmissionStore.read()) !== null;
          runtimeState = {
            ...runtimeState,
            mode:
              result.reason === 'pending-submission-timeout' && hasPendingSubmission
                ? 'circuit_open'
                : hasPendingSubmission
                  ? 'recovering'
                  : 'healthy',
            circuitReason: hasPendingSubmission ? result.reason : '',
            cooldownUntil:
              result.reason === 'pending-submission-timeout' && hasPendingSubmission
                ? new Date(Date.now() + 5 * 60_000).toISOString()
                : hasPendingSubmission
                  ? runtimeState.cooldownUntil
                  : '',
            lastHealthyAt: !hasPendingSubmission ? nowIso() : runtimeState.lastHealthyAt,
            updatedAt: nowIso()
          };
          runtimeStateExplicitlySet = true;
        }

        if (result.quoteCollected) {
          dependencyHealth = markDependencySuccess(dependencyHealth, 'quote', nowIso());
        }

        if (result.liveOrderSubmitted) {
          dependencyHealth = markDependencySuccess(dependencyHealth, 'signer', nowIso());
          dependencyHealth = markDependencySuccess(dependencyHealth, 'broadcaster', nowIso());
        }

        if (cycleInput.confirmationProvider && result.confirmationStatus && result.confirmationStatus !== 'unknown') {
          dependencyHealth = markDependencySuccess(dependencyHealth, 'confirmation', nowIso());
        }

        if ((cycleInput.accountProvider || effectiveAccountState) && result.reason !== 'balance-mismatch') {
          dependencyHealth = markDependencySuccess(dependencyHealth, 'account', nowIso());
        }

        if (result.reason === 'balance-mismatch') {
          dependencyHealth = markDependencyFailure(
            dependencyHealth,
            'account',
            result.reason,
            nowIso()
          );
        }

        let postTickPendingSubmission = await pendingSubmissionStore.read();
        if (postTickPendingSubmission && effectiveAccountState) {
          const postTickRecovery = await recoverPendingSubmission({
            pendingSubmission: postTickPendingSubmission,
            confirmationProvider: cycleInput.confirmationProvider,
            accountState: effectiveAccountState
          });

          if (postTickRecovery.clearPending) {
            await pendingSubmissionStore.clear();
            postTickPendingSubmission = null;
          } else if (postTickRecovery.nextPendingSubmission) {
            await pendingSubmissionStore.write(postTickRecovery.nextPendingSubmission);
            postTickPendingSubmission = postTickRecovery.nextPendingSubmission;
          }
        }

        if (!runtimeStateExplicitlySet) {
          const postTickDerived = deriveRuntimeMode({
            currentMode: runtimeState.mode,
            quoteFailures: dependencyHealth.quote.consecutiveFailures,
            reconcileFailures: dependencyHealth.account.consecutiveFailures,
            hasUnknownSubmissionOutcome: postTickPendingSubmission?.confirmationStatus === 'unknown',
            cooldownActive:
              postTickPendingSubmission !== null &&
              runtimeState.cooldownUntil !== '' &&
              runtimeState.cooldownUntil > nowIso(),
            flattenOnlyRequested: runtimeState.mode === 'flatten_only'
          });

          runtimeState = applyDerivedRuntimeState({
            currentState: runtimeState,
            derived: postTickDerived,
            pendingSubmission: postTickPendingSubmission !== null,
            now: nowIso()
          });
        }

        const housekeeping = housekeepingRunner
          ? await housekeepingRunner.runIfDue()
          : undefined;

        const report = buildHealthReport({
          mode: runtimeState.mode,
          allowNewOpens:
            runtimeState.mode === 'healthy' || runtimeState.mode === 'degraded',
          flattenOnly: runtimeState.mode === 'flatten_only',
          pendingSubmission: (await pendingSubmissionStore.read()) !== null,
          circuitReason: runtimeState.circuitReason,
          lastSuccessfulTickAt: nowIso(),
          dependencyHealth: {
            quoteFailures: dependencyHealth.quote.consecutiveFailures,
            reconcileFailures: dependencyHealth.account.consecutiveFailures
          },
          housekeeping,
          mirror: mirrorRuntime?.snapshot()
        });

        await runtimeStateStore.writeRuntimeState(runtimeState);
        await runtimeStateStore.writeDependencyHealth(dependencyHealth);
        const persistedActiveMint = typeof result.context?.token?.mint === 'string' ? result.context.token.mint : '';
        const persistedLifecycleState = resolveLifecycleStateForPersist({
          nextLifecycleState: result.nextLifecycleState,
          previousLifecycleState: positionState?.lifecycleState,
          pendingSubmission: (await pendingSubmissionStore.read()) !== null,
          accountState: effectiveAccountState,
          lastAction: result.action,
          lastReason: result.reason,
          activeMint: persistedActiveMint
        });

        const failedOpenCooldownMint = result.reason.startsWith('failed-open-cooldown:')
          ? result.reason.slice('failed-open-cooldown:'.length)
          : '';
        const shouldRecordClosedMint = isExposureReducingAction(result.action) || failedOpenCooldownMint.length > 0;
        const closedMint = shouldRecordClosedMint
          ? (failedOpenCooldownMint || persistedActiveMint)
          : (positionState?.lastClosedMint ?? '');
        const closedAt = shouldRecordClosedMint ? nowIso() : (positionState?.lastClosedAt ?? '');
        await runtimeStateStore.writePositionState({
          allowNewOpens: runtimeState.mode === 'healthy' || runtimeState.mode === 'degraded',
          flattenOnly: runtimeState.mode === 'flatten_only',
          lastAction: result.action,
          lastReason: result.reason,
          activeMint: persistedActiveMint,
          lifecycleState: persistedLifecycleState,
          lastClosedMint: closedMint,
          lastClosedAt: closedAt,
          updatedAt: nowIso()
        });
        await runtimeStateStore.writeHealthReport(report);
        await mirrorRuntime?.flushOnce();

        if (mirrorRuntime) {
          const caughtUpEvents = await enqueueMirrorCatchupFromJournals({
            strategyId: options.strategy,
            stateRootDir,
            journalRootDir,
            mirrorRuntime
          });

          if (caughtUpEvents > 0) {
            await mirrorRuntime.flushOnce();
          }
        }

        if (shouldSendAlert({
          previousMode,
          nextMode: runtimeState.mode,
          reason: runtimeState.circuitReason
        })) {
          await alertSink.send({
            previousMode,
            nextMode: runtimeState.mode,
            reason: runtimeState.circuitReason,
            sentAt: nowIso()
          });
        }
      } catch (error) {
        const now = nowIso();

        if (error instanceof ExecutionRequestError) {
          const dependencyKey = error.operation === 'broadcast'
            ? 'broadcaster'
            : error.operation === 'signer'
              ? 'signer'
              : error.operation === 'confirmation'
                ? 'confirmation'
                : error.operation === 'account'
                  ? 'account'
                  : 'quote';

          dependencyHealth = markDependencyFailure(
            dependencyHealth,
            dependencyKey,
            error.reason,
            now
          );
        }

        runtimeState = {
          ...runtimeState,
          mode: 'circuit_open',
          circuitReason: error instanceof Error ? error.message : String(error),
          cooldownUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
          updatedAt: now
        };

        const report = buildHealthReport({
          mode: runtimeState.mode,
          allowNewOpens: false,
          flattenOnly: runtimeState.mode === 'flatten_only',
          pendingSubmission: (await pendingSubmissionStore.read()) !== null,
          circuitReason: runtimeState.circuitReason,
          lastSuccessfulTickAt: runtimeState.lastHealthyAt,
          dependencyHealth: {
            quoteFailures: dependencyHealth.quote.consecutiveFailures,
            reconcileFailures: dependencyHealth.account.consecutiveFailures
          },
          housekeeping: housekeepingRunner?.snapshot(),
          mirror: mirrorRuntime?.snapshot(),
          updatedAt: now
        });

        await runtimeStateStore.writeRuntimeState(runtimeState);
        await runtimeStateStore.writeDependencyHealth(dependencyHealth);
        await runtimeStateStore.writePositionState({
          allowNewOpens: false,
          flattenOnly: runtimeState.mode === 'flatten_only',
          lastAction: 'hold',
          lifecycleState: resolveLifecycleStateForPersist({
            previousLifecycleState: positionState?.lifecycleState,
            pendingSubmission: (await pendingSubmissionStore.read()) !== null,
            accountState: effectiveAccountState
          }),
          lastClosedMint: positionState?.lastClosedMint,
          lastClosedAt: positionState?.lastClosedAt,
          updatedAt: now
        });
        await runtimeStateStore.writeHealthReport(report);
        await mirrorRuntime?.flushOnce();

        if (shouldSendAlert({
          previousMode,
          nextMode: runtimeState.mode,
          reason: runtimeState.circuitReason
        })) {
          await alertSink.send({
            previousMode,
            nextMode: runtimeState.mode,
            reason: runtimeState.circuitReason,
            sentAt: now
          });
        }
      }

      if (tickCount < maxTicks) {
        await wait(tickIntervalMs);
      }
    }
  } finally {
    await mirrorRuntime?.stop();
  }

  return {
    tickCount,
    stateRootDir,
    journalRootDir
  };
}
