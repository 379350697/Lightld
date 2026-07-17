import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clearTokenSafetyCacheForTests,
  fetchTokenSafetyBatch,
  getTokenSafetyCacheSize,
  GMGN_SAFETY_DEFERRED_ERROR,
  isTokenSafe,
  primeTokenSafetyCacheForTests,
  resolveGmgnSafetyTimeoutMs,
  sweepTokenSafetyCache
} from '../../../src/ingest/gmgn/token-safety-client';

describe('GMGN token safety cache', () => {
  it('fails closed when required holder or bluechip evidence is missing or below policy', () => {
    const base = {
      mint: 'mint-policy',
      safe: true,
      safetyScore: 80,
      maxScore: 120
    };

    expect(isTokenSafe(base)).toBe(false);
    expect(isTokenSafe({ ...base, holders: 2_000, bluechipPct: 0.7 })).toBe(false);
    expect(isTokenSafe({ ...base, holders: 2_000, bluechipPct: 1 })).toBe(true);
  });

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

  it("computes bounded dynamic subprocess timeouts", () => {
    expect(resolveGmgnSafetyTimeoutMs(0)).toBe(30_000);
    expect(resolveGmgnSafetyTimeoutMs(5)).toBe(275_000);
    expect(resolveGmgnSafetyTimeoutMs(50)).toBe(360_000);
  });

  it("returns deferred safety results for uncached mints beyond the batch budget", async () => {
    clearTokenSafetyCacheForTests();
    const firstMint = "11111111111111111111111111111111";
    const secondMint = "22222222222222222222222222222222";
    const wrapperPath = join(tmpdir(), `gmgn-budget-${process.pid}-${Date.now()}.js`);
    writeFileSync(wrapperPath, `#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const mints = JSON.parse(raw || '[]');
  process.stdout.write(JSON.stringify(mints.map((mint) => ({
    mint,
    safe: true,
    safetyScore: 80,
    maxScore: 120
  }))));
});
`);
    chmodSync(wrapperPath, 0o755);

    try {
      const results = await fetchTokenSafetyBatch([firstMint, secondMint], {
        pythonBin: wrapperPath,
        timeoutMs: 3_000,
        maxBatchSize: 1
      });

      expect(results).toEqual([
        expect.objectContaining({
          mint: firstMint,
          safe: true,
          safetyScore: 80
        }),
        expect.objectContaining({
          mint: secondMint,
          safe: false,
          safetyScore: 0,
          error: GMGN_SAFETY_DEFERRED_ERROR
        })
      ]);
      expect(getTokenSafetyCacheSize()).toBe(1);
    } finally {
      rmSync(wrapperPath, { force: true });
    }
  });

  it("returns failed safety results when the subprocess timeout expires", async () => {
    clearTokenSafetyCacheForTests();
    const mint = "So11111111111111111111111111111111111111112";
    const wrapperPath = join(tmpdir(), `gmgn-timeout-${process.pid}-${Date.now()}.js`);
    writeFileSync(wrapperPath, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
    chmodSync(wrapperPath, 0o755);

    try {
      const startedAt = Date.now();
      const [result] = await fetchTokenSafetyBatch([mint], {
        pythonBin: wrapperPath,
        timeoutMs: 100,
        maxBatchSize: 1
      });

      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(result).toMatchObject({
        mint,
        safe: false,
        safetyScore: 0,
        maxScore: 120,
        error: "script_error: timeout after 100ms"
      });
    } finally {
      rmSync(wrapperPath, { force: true });
    }
  });
});
