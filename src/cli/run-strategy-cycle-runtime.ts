import { loadLiveRuntimeConfig } from '../runtime/live-runtime-config.ts';

export type StrategyCycleRunMode = 'live' | 'mechanical-soak';

function requirePath(env: Record<string, string | undefined>, name: string) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be explicitly set for run:strategy`);
  }
  return value;
}

function parseRequiredBoolean(env: Record<string, string | undefined>, name: string) {
  const value = env[name]?.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value ?? '')) return true;
  if (['0', 'false', 'no', 'off'].includes(value ?? '')) return false;
  throw new Error(`${name} must be explicitly set to true or false for run:strategy`);
}

/**
 * The one-shot strategy CLI is a real runtime entrypoint, not a test harness.
 * Unit tests may call runStrategyCycle directly with explicit test adapters and
 * isolated tmp paths, but this CLI must use the same HTTP execution boundary as
 * the daemon so a stub broadcaster can never report a synthetic submission.
 */
export function loadStrategyCycleRuntime(
  env: Record<string, string | undefined> = process.env
) {
  const runMode = env.LIGHTLD_RUN_MODE;
  if (runMode !== 'live' && runMode !== 'mechanical-soak') {
    throw new Error('run:strategy requires LIGHTLD_RUN_MODE=live or mechanical-soak');
  }

  if (env.LIGHTLD_EXECUTION_MODE !== runMode) {
    throw new Error(`LIGHTLD_EXECUTION_MODE must match LIGHTLD_RUN_MODE (${runMode})`);
  }

  if (runMode === 'live' && env.LIGHTLD_LIVE_CONFIRM !== 'I_UNDERSTAND_MAINNET') {
    throw new Error('Live mode requires LIGHTLD_LIVE_CONFIRM=I_UNDERSTAND_MAINNET');
  }

  const dryRun = parseRequiredBoolean(env, 'SOLANA_EXECUTION_DRY_RUN');
  if (runMode === 'live' && dryRun) {
    throw new Error('Live mode cannot run with SOLANA_EXECUTION_DRY_RUN=true');
  }
  if (runMode === 'mechanical-soak' && !dryRun) {
    throw new Error('mechanical-soak requires SOLANA_EXECUTION_DRY_RUN=true');
  }

  if (env.LIVE_EXECUTION_MODE !== 'http') {
    throw new Error(
      'run:strategy requires LIVE_EXECUTION_MODE=http; test adapters are available only to direct unit-test calls'
    );
  }

  const runtimeConfig = loadLiveRuntimeConfig(env);
  if (runtimeConfig.executionMode !== 'http') {
    throw new Error('run:strategy requires the HTTP quote, signer, broadcaster, confirmation and account services');
  }

  return {
    runMode: runMode as StrategyCycleRunMode,
    stateRootDir: requirePath(env, 'LIVE_STATE_DIR'),
    journalRootDir: requirePath(env, 'LIVE_JOURNAL_DIR'),
    runtimeConfig
  };
}
