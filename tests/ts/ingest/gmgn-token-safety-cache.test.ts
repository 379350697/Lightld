import { describe, expect, it } from 'vitest';

import {
  clearTokenSafetyCacheForTests,
  getTokenSafetyCacheSize,
  primeTokenSafetyCacheForTests,
  sweepTokenSafetyCache
} from '../../../src/ingest/gmgn/token-safety-client';

describe('GMGN token safety cache', () => {
  it('sweeps expired entries before enforcing the max entry limit', () => {
    clearTokenSafetyCacheForTests();
    primeTokenSafetyCacheForTests('mint-expired', {
      mint: 'mint-expired',
      safe: true,
      safetyScore: 100,
      maxScore: 120
    }, new Date('2026-04-10T00:00:00.000Z'));
    primeTokenSafetyCacheForTests('mint-fresh-a', {
      mint: 'mint-fresh-a',
      safe: true,
      safetyScore: 80,
      maxScore: 120
    }, new Date('2026-04-14T00:00:00.000Z'));
    primeTokenSafetyCacheForTests('mint-fresh-b', {
      mint: 'mint-fresh-b',
      safe: true,
      safetyScore: 70,
      maxScore: 120
    }, new Date('2026-04-14T00:01:00.000Z'));

    const result = sweepTokenSafetyCache({
      now: new Date('2026-04-14T12:00:00.000Z'),
      ttlMs: 24 * 60 * 60 * 1000,
      maxEntries: 5
    });

    expect(result.expiredDeleted).toBe(1);
    expect(result.evictedDeleted).toBe(0);
    expect(result.remainingEntries).toBe(2);
    expect(getTokenSafetyCacheSize()).toBe(2);
  });

  it('evicts the oldest surviving entries when the cache remains over limit', () => {
    clearTokenSafetyCacheForTests();
    primeTokenSafetyCacheForTests('mint-a', {
      mint: 'mint-a',
      safe: true,
      safetyScore: 90,
      maxScore: 120
    }, new Date('2026-04-14T00:00:00.000Z'));
    primeTokenSafetyCacheForTests('mint-b', {
      mint: 'mint-b',
      safe: true,
      safetyScore: 80,
      maxScore: 120
    }, new Date('2026-04-14T00:01:00.000Z'));
    primeTokenSafetyCacheForTests('mint-c', {
      mint: 'mint-c',
      safe: true,
      safetyScore: 70,
      maxScore: 120
    }, new Date('2026-04-14T00:02:00.000Z'));

    const result = sweepTokenSafetyCache({
      now: new Date('2026-04-14T00:03:00.000Z'),
      ttlMs: 24 * 60 * 60 * 1000,
      maxEntries: 2
    });

    expect(result.expiredDeleted).toBe(0);
    expect(result.evictedDeleted).toBe(1);
    expect(result.remainingEntries).toBe(2);
    expect(getTokenSafetyCacheSize()).toBe(2);
  });
});
