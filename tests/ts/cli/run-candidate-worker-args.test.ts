import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CANDIDATE_REFRESH_GRACE_MS,
  DEFAULT_CANDIDATE_WORKER_INTERVAL_MS,
  resolveCandidatePoolStaleMs,
  resolveCandidateWorkerIntervalMs,
  resolveCandidateWorkerLeaseMs
} from '../../../src/cli/run-candidate-worker-args';

describe('candidate worker interval', () => {
  it('defaults to one sample every 15 minutes', () => {
    expect(DEFAULT_CANDIDATE_WORKER_INTERVAL_MS).toBe(900_000);
    expect(resolveCandidateWorkerIntervalMs([], {})).toBe(900_000);
  });

  it('honors the environment override', () => {
    expect(resolveCandidateWorkerIntervalMs([], {
      LIVE_CANDIDATE_WORKER_INTERVAL_MS: '120000'
    })).toBe(120_000);
  });

  it('gives the CLI override precedence over the environment', () => {
    expect(resolveCandidateWorkerIntervalMs(['--interval-ms', '300000'], {
      LIVE_CANDIDATE_WORKER_INTERVAL_MS: '120000'
    })).toBe(300_000);
  });

  it('keeps observations and the worker lease valid through the next scheduled tick', () => {
    expect(DEFAULT_CANDIDATE_REFRESH_GRACE_MS).toBe(300_000);
    expect(resolveCandidatePoolStaleMs({})).toBe(1_200_000);
    expect(resolveCandidateWorkerLeaseMs({})).toBe(1_200_000);
  });

  it('derives freshness from an overridden interval and honors explicit freshness overrides', () => {
    expect(resolveCandidatePoolStaleMs({
      LIVE_CANDIDATE_WORKER_INTERVAL_MS: '120000'
    })).toBe(420_000);
    expect(resolveCandidatePoolStaleMs({
      LIVE_CANDIDATE_WORKER_INTERVAL_MS: '120000',
      LIVE_CANDIDATE_POOL_STALE_MS: '600000'
    })).toBe(600_000);
    expect(resolveCandidateWorkerLeaseMs({
      LIVE_CANDIDATE_WORKER_INTERVAL_MS: '120000',
      LIVE_CANDIDATE_POOL_STALE_MS: '600000',
      LIVE_CANDIDATE_WORKER_LEASE_MS: '900000'
    })).toBe(900_000);
  });

  it('rejects an invalid explicit CLI interval instead of entering a tight loop', () => {
    expect(() => resolveCandidateWorkerIntervalMs(['--interval-ms', '0'], {}))
      .toThrow('Expected --interval-ms to be a positive integer');
    expect(() => resolveCandidateWorkerIntervalMs(['--interval-ms'], {}))
      .toThrow('Expected --interval-ms to be a positive integer');
  });
});
