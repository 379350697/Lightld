import { rm } from 'node:fs/promises';

import { beforeEach, describe, expect, it } from 'vitest';

import { runStrategyCycle } from '../../../src/cli/run-strategy-cycle';
import { loadStrategyCycleRuntime } from '../../../src/cli/run-strategy-cycle-runtime';

const HTTP_ENV = {
  LIVE_EXECUTION_MODE: 'http',
  LIVE_QUOTE_URL: 'https://quote.example/api',
  LIVE_SIGN_URL: 'https://sign.example/api',
  LIVE_BROADCAST_URL: 'https://broadcast.example/api',
  LIVE_CONFIRMATION_URL: 'https://confirm.example/api',
  LIVE_ACCOUNT_STATE_URL: 'https://account.example/api',
  LIVE_STATE_DIR: 'tmp/tests/run-strategy-cycle-state',
  LIVE_JOURNAL_DIR: 'tmp/tests/run-strategy-cycle-journals'
} as const;

describe('runStrategyCycle', () => {
  beforeEach(async () => {
    await rm('tmp/tests/run-strategy-cycle-state', { recursive: true, force: true });
    await rm('tmp/tests/run-strategy-cycle-journals', { recursive: true, force: true });
  });

  it('returns a live decision summary', async () => {
    const result = await runStrategyCycle({
      strategy: 'new-token-v1',
      stateRootDir: 'tmp/tests/run-strategy-cycle-state',
      journalRootDir: 'tmp/tests/run-strategy-cycle-journals',
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        chainPositionAddress: 'pos-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.status).toBe('ok');
    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
  });

  it('fails the CLI runtime closed when no explicit business mode is provided', () => {
    expect(() => loadStrategyCycleRuntime(HTTP_ENV)).toThrow(
      'run:strategy requires LIGHTLD_RUN_MODE=live or mechanical-soak'
    );
  });

  it('rejects test adapters even when a business mode is explicit', () => {
    expect(() => loadStrategyCycleRuntime({
      ...HTTP_ENV,
      LIGHTLD_RUN_MODE: 'mechanical-soak',
      LIGHTLD_EXECUTION_MODE: 'mechanical-soak',
      SOLANA_EXECUTION_DRY_RUN: 'true',
      LIVE_EXECUTION_MODE: 'test'
    })).toThrow('run:strategy requires LIVE_EXECUTION_MODE=http');
  });

  it('loads mechanical paper only with the signed HTTP path and isolated paths', () => {
    const runtime = loadStrategyCycleRuntime({
      ...HTTP_ENV,
      LIGHTLD_RUN_MODE: 'mechanical-soak',
      LIGHTLD_EXECUTION_MODE: 'mechanical-soak',
      SOLANA_EXECUTION_DRY_RUN: 'true'
    });

    expect(runtime).toMatchObject({
      runMode: 'mechanical-soak',
      stateRootDir: HTTP_ENV.LIVE_STATE_DIR,
      journalRootDir: HTTP_ENV.LIVE_JOURNAL_DIR,
      runtimeConfig: { executionMode: 'http' }
    });
  });

  it('rejects a paper/live dry-run mismatch and missing formal paths', () => {
    expect(() => loadStrategyCycleRuntime({
      ...HTTP_ENV,
      LIGHTLD_RUN_MODE: 'mechanical-soak',
      LIGHTLD_EXECUTION_MODE: 'mechanical-soak',
      SOLANA_EXECUTION_DRY_RUN: 'false'
    })).toThrow('mechanical-soak requires SOLANA_EXECUTION_DRY_RUN=true');

    expect(() => loadStrategyCycleRuntime({
      ...HTTP_ENV,
      LIGHTLD_RUN_MODE: 'live',
      LIGHTLD_EXECUTION_MODE: 'live',
      LIGHTLD_LIVE_CONFIRM: 'I_UNDERSTAND_MAINNET',
      SOLANA_EXECUTION_DRY_RUN: 'false',
      LIVE_STATE_DIR: ''
    })).toThrow('LIVE_STATE_DIR must be explicitly set for run:strategy');
  });
});
