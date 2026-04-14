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
    ).toEqual({
      executionMode: 'http',
      quoteServiceUrl: 'https://quote.example/api',
      signServiceUrl: 'https://sign.example/api',
      broadcastServiceUrl: 'https://broadcast.example/api',
      confirmationServiceUrl: 'https://confirm.example/api',
      accountStateUrl: 'https://account.example/api',
      authToken: 'secret'
    });
  });
});
