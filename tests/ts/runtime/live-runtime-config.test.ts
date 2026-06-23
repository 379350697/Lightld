import { describe, expect, it } from 'vitest';

import { loadLiveRuntimeConfig } from '../../../src/runtime/live-runtime-config';

describe('loadLiveRuntimeConfig', () => {
  it('defaults to test execution mode when no env vars are provided', () => {
    expect(loadLiveRuntimeConfig({})).toEqual({
      executionMode: 'test'
    });
  });

  it('loads validated http execution config from env', () => {
    expect(
      loadLiveRuntimeConfig({
        LIVE_EXECUTION_MODE: 'http',
        LIVE_QUOTE_URL: 'https://quote.example/api',
        LIVE_SIGN_URL: 'https://sign.example/api',
        LIVE_BROADCAST_URL: 'https://broadcast.example/api',
        LIVE_CONFIRMATION_URL: 'https://confirm.example/api',
        LIVE_ACCOUNT_STATE_URL: 'https://account.example/api',
        LIVE_AUTH_TOKEN: 'secret'
      })
    ).toMatchObject({
      executionMode: 'http',
      quoteServiceUrl: 'https://quote.example/api',
      signServiceUrl: 'https://sign.example/api',
      broadcastServiceUrl: 'https://broadcast.example/api',
      broadcastTimeoutMs: 30_000,
      confirmationServiceUrl: 'https://confirm.example/api',
      accountStateUrl: 'https://account.example/api',
      authToken: 'secret'
    });
  });

  it('loads a custom broadcast timeout override from env', () => {
    expect(
      loadLiveRuntimeConfig({
        LIVE_EXECUTION_MODE: 'http',
        LIVE_QUOTE_URL: 'https://quote.example/api',
        LIVE_SIGN_URL: 'https://sign.example/api',
        LIVE_BROADCAST_URL: 'https://broadcast.example/api',
        LIVE_CONFIRMATION_URL: 'https://confirm.example/api',
        LIVE_ACCOUNT_STATE_URL: 'https://account.example/api',
        LIVE_BROADCAST_TIMEOUT_MS: '22000'
      })
    ).toMatchObject({
      executionMode: 'http',
      broadcastTimeoutMs: 22_000
    });
  });

  it('loads spending limit overrides from env', () => {
    expect(
      loadLiveRuntimeConfig({
        LIVE_MAX_SINGLE_ORDER_SOL: '0.1',
        LIVE_MAX_DAILY_SPEND_SOL: '2.5',
        LIVE_MAX_HOURLY_SPEND_SOL: '0.5',
        LIVE_RESET_SPENDING_LIMITS_ON_START: 'true'
      })
    ).toEqual({
      executionMode: 'test',
      maxSingleOrderSol: 0.1,
      maxDailySpendSol: 2.5,
      maxHourlySpendSol: 0.5,
      resetSpendingLimitsOnStartup: true
    });
  });
});
