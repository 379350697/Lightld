import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIVE_DAEMON_HOT_TICK_INTERVAL_MS,
  DEFAULT_LIVE_DAEMON_TICK_INTERVAL_MS,
  resolveLiveDaemonTiming
} from '../../../src/cli/run-live-daemon-args';

describe('live daemon timing', () => {
  it('uses the same 10s/2s defaults as the paper launcher', () => {
    expect(DEFAULT_LIVE_DAEMON_TICK_INTERVAL_MS).toBe(10_000);
    expect(DEFAULT_LIVE_DAEMON_HOT_TICK_INTERVAL_MS).toBe(2_000);
    expect(resolveLiveDaemonTiming([], {})).toEqual({
      tickIntervalMs: 10_000,
      hotTickIntervalMs: 2_000
    });
  });

  it('honors environment and CLI overrides with CLI precedence', () => {
    expect(resolveLiveDaemonTiming([
      '--tick-interval-ms', '12000',
      '--hot-tick-interval-ms', '1500'
    ], {
      LIVE_DAEMON_TICK_INTERVAL_MS: '20000',
      LIVE_DAEMON_HOT_TICK_INTERVAL_MS: '2500'
    })).toEqual({
      tickIntervalMs: 12_000,
      hotTickIntervalMs: 1_500
    });
  });

  it('rejects invalid explicit intervals instead of spinning', () => {
    expect(() => resolveLiveDaemonTiming(['--tick-interval-ms', '0'], {}))
      .toThrow('Expected --tick-interval-ms to be a positive integer');
    expect(() => resolveLiveDaemonTiming(['--hot-tick-interval-ms'], {}))
      .toThrow('Expected --hot-tick-interval-ms to be a positive integer');
  });
});
