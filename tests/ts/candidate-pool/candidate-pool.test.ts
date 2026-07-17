import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveCandidatePoolEntry } from '../../../src/candidate-pool/aggregator';
import { buildMeteoraCandidate, isRecentMeteoraPool } from '../../../src/candidate-pool/meteora-candidate-builder';
import { buildMeteoraObservation, buildRouteObservation } from '../../../src/candidate-pool/source-observations';
import { SqliteCandidatePool } from '../../../src/candidate-pool/sqlite-candidate-pool';
import type { CandidateSourceObservation } from '../../../src/candidate-pool/types';
import type { IngestCandidate } from '../../../src/runtime/ingest-candidate-selection';

const roots: string[] = [];

function makeCandidate(overrides: Partial<IngestCandidate> = {}): IngestCandidate {
  return {
    address: 'pool-1',
    mint: 'mint-1',
    symbol: 'SAFE',
    quoteMint: 'So11111111111111111111111111111111111111112',
    liquidityUsd: 25_000,
    hasSolRoute: true,
    capturedAt: '2026-06-21T10:00:00.000Z',
    holders: 0,
    hasInventory: false,
    hasLpPosition: false,
    binStep: 120,
    baseFeePct: 1,
    volume24h: 2_000_000,
    feeTvlRatio24h: 0.12,
    feeTvlRatioUnit: 'ratio',
    auxSignalScore: 0,
    dexscreenerBoostAmount: 0,
    dexscreenerHasProfile: false,
    jupiterOrganicScore: 0,
    jupiterTrendingRank: 0,
    coingeckoTrendingRank: 0,
    auxSignalStatus: 'disabled',
    ...overrides
  };
}

function observation(source: CandidateSourceObservation['source'], overrides: Partial<CandidateSourceObservation> = {}): CandidateSourceObservation {
  return {
    strategyId: 'new-token-v1',
    poolAddress: 'pool-1',
    tokenMint: 'mint-1',
    source,
    status: 'passed',
    observedAt: '2026-06-21T10:00:00.000Z',
    expiresAt: '2026-06-21T10:01:00.000Z',
    latencyMs: 1,
    score: source === 'gmgn' ? 80 : 10,
    hardRejectReason: '',
    rawJson: {},
    ...overrides
  };
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('candidate pool aggregation', () => {
  it('uses the pool creation timestamp rather than the mutable update timestamp', () => {
    const candidate = buildMeteoraCandidate({
      address: 'pool-time',
      baseMint: 'mint-time',
      baseSymbol: 'TIME',
      quoteMint: 'So11111111111111111111111111111111111111112',
      created_at: 1_751_328_000_000,
      updatedAt: '2026-07-16T00:00:00.000Z'
    });
    expect(candidate.capturedAt).toBe('2025-07-01T00:00:00.000Z');
  });

  it('accepts seconds, milliseconds and ISO pool creation times but rejects future pools', () => {
    const now = new Date('2026-07-16T12:00:00.000Z');
    const recent = Date.parse('2026-07-16T11:00:00.000Z');
    const maxAgeMs = 2 * 60 * 60_000;

    expect(isRecentMeteoraPool({ created_at: recent }, now, maxAgeMs)).toBe(true);
    expect(isRecentMeteoraPool({ created_at: recent / 1000 }, now, maxAgeMs)).toBe(true);
    expect(isRecentMeteoraPool({ created_at: '2026-07-16T11:00:00.000Z' }, now, maxAgeMs)).toBe(true);
    expect(isRecentMeteoraPool({ created_at: '2026-07-16T13:00:00.000Z' }, now, maxAgeMs)).toBe(false);
  });

  it('marks candidates openable when hard sources are fresh and passed', () => {
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [observation('meteora'), observation('jupiter_route'), observation('gmgn')]
    });

    expect(entry.status).toBe('openable');
    expect(entry.openable).toBe(true);
    expect(entry.blockReason).toBe('');
  });

  it('keeps a candidate non-openable until GMGN is fresh and passed', () => {
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [observation('meteora'), observation('jupiter_route')]
    });

    expect(entry.status).toBe('eligible');
    expect(entry.openable).toBe(false);
    expect(entry.blockReason).toBe('missing-gmgn');
  });

  it.each(['failed', 'deferred'] as const)('fails closed when GMGN is %s', (status) => {
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [
        observation('meteora'),
        observation('jupiter_route'),
        observation('gmgn', { status, score: 0 })
      ]
    });

    expect(entry.status).toBe('source_unavailable');
    expect(entry.openable).toBe(false);
    expect(entry.blockReason).toBe(`gmgn-${status}`);
  });

  it('marks LP-eligible candidates eligible until Jupiter route is fresh', () => {
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [observation('meteora')]
    });

    expect(entry.status).toBe('eligible');
    expect(entry.openable).toBe(false);
    expect(entry.blockReason).toBe('missing-jupiter_route');
  });

  it('blocks on a fresh explicit GMGN rejection and fails closed on stale GMGN evidence', () => {
    const blocked = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [
        observation('meteora'),
        observation('jupiter_route'),
        observation('gmgn', { status: 'blocked', hardRejectReason: 'holders=0<=1000' })
      ]
    });
    const staleGmgn = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [
        observation('meteora'),
        observation('jupiter_route'),
        observation('gmgn', {
          status: 'blocked',
          expiresAt: '2026-06-21T09:59:00.000Z',
          hardRejectReason: 'holders=0<=1000'
        })
      ]
    });

    expect(blocked.status).toBe('blocked');
    expect(blocked.blockReason).toContain('gmgn:holders=0<=1000');
    expect(staleGmgn.status).toBe('stale');
    expect(staleGmgn.openable).toBe(false);
    expect(staleGmgn.blockReason).toBe('stale-gmgn');
  });

  it('blocks bad pool fee yield profiles without making fee yield a hard dependency', () => {
    const missingProfile = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({ poolFeeYieldStatus: 'yield_profile_missing' }),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [
        observation('meteora'),
        observation('jupiter_route'),
        observation('gmgn'),
        observation('pool_fee_yield', {
          status: 'deferred',
          score: 0,
          rawJson: { status: 'yield_profile_missing' }
        })
      ]
    });
    const retired = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({ poolFeeYieldStatus: 'retired_liquidity_drain' }),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [
        observation('meteora'),
        observation('jupiter_route'),
        observation('gmgn'),
        observation('pool_fee_yield', {
          status: 'blocked',
          score: 0,
          hardRejectReason: 'tvl-dropped-more-than-50pct',
          rawJson: { status: 'retired_liquidity_drain' }
        })
      ]
    });
    const drainWatch = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({ poolFeeYieldStatus: 'liquidity_drain_watch' }),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [
        observation('meteora'),
        observation('jupiter_route'),
        observation('gmgn'),
        observation('pool_fee_yield', {
          status: 'blocked',
          score: 0,
          hardRejectReason: 'tvl-dropped-more-than-35pct',
          rawJson: { status: 'liquidity_drain_watch' }
        })
      ]
    });

    expect(missingProfile.status).toBe('openable');
    expect(retired.status).toBe('blocked');
    expect(retired.blockReason).toBe('pool_fee_yield:tvl-dropped-more-than-50pct');
    expect(drainWatch.status).toBe('blocked');
    expect(drainWatch.blockReason).toBe('pool_fee_yield:tvl-dropped-more-than-35pct');
  });

  it('treats expired hard source blocks as stale instead of permanent blocks', () => {
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [
        observation('meteora'),
        observation('jupiter_route', {
          status: 'blocked',
          expiresAt: '2026-06-21T09:59:00.000Z',
          hardRejectReason: 'no-jupiter-sol-route'
        })
      ]
    });

    expect(entry.status).toBe('stale');
    expect(entry.openable).toBe(false);
    expect(entry.blockReason).toBe('stale-jupiter_route');
  });

  it('marks fresh hard source failures as source unavailable', () => {
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [
        observation('meteora'),
        observation('jupiter_route', {
          status: 'failed',
          hardRejectReason: 'jupiter-route-check-failed'
        })
      ]
    });

    expect(entry.status).toBe('source_unavailable');
    expect(entry.openable).toBe(false);
    expect(entry.blockReason).toBe('jupiter_route-failed');
  });

  it('normalizes Meteora fee/tvl percent-numbers at the ingest boundary', () => {
    const halfPercent = buildMeteoraCandidate({
      address: 'pool-half-percent',
      baseMint: 'mint-half-percent',
      baseSymbol: 'HALF',
      quoteMint: 'So11111111111111111111111111111111111111112',
      created_at: '2026-06-21T09:00:00.000Z',
      fee_tvl_ratio: { '24h': 0.5 }
    });
    const highPercent = buildMeteoraCandidate({
      address: 'pool-high-percent',
      baseMint: 'mint-high-percent',
      baseSymbol: 'HIGH',
      quoteMint: 'So11111111111111111111111111111111111111112',
      created_at: '2026-06-21T09:00:00.000Z',
      fee_tvl_ratio: { '24h': 54.8956 }
    });

    expect(halfPercent.feeTvlRatio24h).toBeCloseTo(0.005);
    expect(highPercent.feeTvlRatio24h).toBeCloseTo(0.548956);
    expect(buildMeteoraObservation({
      strategyId: 'new-token-v1',
      candidate: halfPercent,
      now: new Date('2026-06-21T10:00:00.000Z'),
      ttlMs: 60_000
    }).score).toBeCloseTo(0.5);
  });

  it('keeps aggregate rank score separate from GMGN safety and counts fee yield once', () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    const candidate = makeCandidate({ feeTvlRatio24h: 0.005, poolFeeYieldScore: 30 });
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate,
      now,
      observations: [
        buildMeteoraObservation({ strategyId: 'new-token-v1', candidate, now, ttlMs: 60_000 }),
        buildRouteObservation({ strategyId: 'new-token-v1', candidate, now, ttlMs: 60_000, routeExists: true }),
        observation('gmgn', { score: 80 }),
        observation('pool_fee_yield', { score: 30 })
      ]
    });

    expect(entry.status).toBe('openable');
    expect(entry.candidate.safetyScore).toBe(80);
    expect(entry.candidate.poolFeeYieldScore).toBe(30);
    expect(entry.score).toBeCloseTo(143);
  });
});

describe('SqliteCandidatePool', () => {
  it('selects only fresh openable candidates and returns null when they go stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-'));
    roots.push(root);
    const path = join(root, 'pool.sqlite');
    const pool = new SqliteCandidatePool({ path });

    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      observedAt: '2026-06-21T10:00:00.000Z',
      sourceObservations: [observation('meteora'), observation('jupiter_route'), observation('gmgn')]
    });

    await expect(pool.selectOpenableCandidate('new-token-v1', {
      now: new Date('2026-06-21T10:00:10.000Z')
    })).resolves.toBeNull();
    await pool.writeWorkerStatus({
      strategyId: 'new-token-v1',
      status: 'ok',
      observedAt: '2026-06-21T10:00:05.000Z',
      expiresAt: '2026-06-21T10:00:30.000Z'
    });
    await expect(pool.selectOpenableCandidate('new-token-v1', {
      now: new Date('2026-06-21T10:00:10.000Z')
    })).resolves.toMatchObject({
      poolAddress: 'pool-1',
      tokenMint: 'mint-1',
      openable: true
    });
    await expect(pool.selectOpenableCandidate('new-token-v1', {
      now: new Date('2026-06-21T10:00:40.000Z')
    })).resolves.toBeNull();
    await pool.writeWorkerStatus({
      strategyId: 'new-token-v1',
      status: 'ok',
      observedAt: '2026-06-21T10:01:30.000Z',
      expiresAt: '2026-06-21T10:03:00.000Z'
    });
    await expect(pool.selectOpenableCandidate('new-token-v1', {
      now: new Date('2026-06-21T10:02:00.000Z')
    })).resolves.toBeNull();

    await pool.close();
  });

  it('skips only the exact open cooldown target when selecting from the candidate pool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-target-cooldown-'));
    roots.push(root);
    const path = join(root, 'pool.sqlite');
    const pool = new SqliteCandidatePool({ path });
    const observedAt = '2026-06-21T10:00:00.000Z';

    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({
        address: 'pool-cooldown',
        mint: 'mint-shared',
        symbol: 'COOL'
      }),
      observedAt,
      sourceObservations: [
        observation('meteora', { poolAddress: 'pool-cooldown', tokenMint: 'mint-shared', score: 80 }),
        observation('jupiter_route', { poolAddress: 'pool-cooldown', tokenMint: 'mint-shared', score: 80 }),
        observation('gmgn', { poolAddress: 'pool-cooldown', tokenMint: 'mint-shared', score: 80 })
      ]
    });
    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({
        address: 'pool-other',
        mint: 'mint-shared',
        symbol: 'OTHER'
      }),
      observedAt,
      sourceObservations: [
        observation('meteora', { poolAddress: 'pool-other', tokenMint: 'mint-shared', score: 10 }),
        observation('jupiter_route', { poolAddress: 'pool-other', tokenMint: 'mint-shared', score: 10 }),
        observation('gmgn', { poolAddress: 'pool-other', tokenMint: 'mint-shared', score: 10 })
      ]
    });
    await pool.writeWorkerStatus({
      strategyId: 'new-token-v1',
      status: 'ok',
      observedAt,
      expiresAt: '2026-06-21T10:01:00.000Z'
    });

    await expect(pool.selectOpenableCandidate('new-token-v1', {
      now: new Date('2026-06-21T10:00:10.000Z'),
      excludedTargets: [{ poolAddress: 'pool-cooldown', tokenMint: 'mint-shared' }]
    })).resolves.toMatchObject({
      poolAddress: 'pool-other',
      tokenMint: 'mint-shared'
    });

    await pool.close();
  });

  it('normalizes legacy persisted Meteora percent-number candidates exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-legacy-fee-unit-'));
    roots.push(root);
    const path = join(root, 'pool.sqlite');
    const pool = new SqliteCandidatePool({ path });
    const observedAt = '2026-06-21T10:00:00.000Z';

    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      observedAt,
      sourceObservations: [observation('meteora'), observation('jupiter_route'), observation('gmgn')]
    });
    await pool.writeWorkerStatus({
      strategyId: 'new-token-v1',
      status: 'ok',
      observedAt,
      expiresAt: '2026-06-21T10:01:00.000Z'
    });
    await pool.close();

    const database = new DatabaseSync(path);
    const legacy = makeCandidate({ feeTvlRatio24h: 50 });
    delete legacy.feeTvlRatioUnit;
    database.prepare('UPDATE candidate_pool SET raw_candidate_json=?').run(JSON.stringify(legacy));
    database.close();

    const reopened = new SqliteCandidatePool({ path, readOnly: true });
    const selected = await reopened.selectOpenableCandidate('new-token-v1', {
      now: new Date('2026-06-21T10:00:10.000Z')
    });
    expect(selected?.candidate.feeTvlRatio24h).toBeCloseTo(0.5, 12);
    expect(selected?.candidate.feeTvlRatioUnit).toBe('ratio');
    await reopened.close();
  });

  it('applies exclusions in SQL before the result limit and preserves score dimensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-sql-exclusions-'));
    roots.push(root);
    const pool = new SqliteCandidatePool({ path: join(root, 'pool.sqlite') });
    const observedAt = '2026-06-21T10:00:00.000Z';
    const excludedMints: string[] = [];

    for (let index = 0; index < 21; index += 1) {
      const poolAddress = `pool-${index}`;
      const tokenMint = `mint-${index}`;
      const sourceScore = 100 - index;
      if (index < 20) excludedMints.push(tokenMint);
      await pool.upsertCandidate({
        strategyId: 'new-token-v1',
        candidate: makeCandidate({
          address: poolAddress,
          mint: tokenMint,
          symbol: `TOKEN${index}`,
          poolFeeYieldScore: 7
        }),
        observedAt,
        sourceObservations: [
          observation('meteora', { poolAddress, tokenMint, score: sourceScore }),
          observation('jupiter_route', { poolAddress, tokenMint, score: 10 }),
          observation('gmgn', { poolAddress, tokenMint, score: 80 }),
          observation('pool_fee_yield', { poolAddress, tokenMint, score: 7 })
        ]
      });
    }
    await pool.writeWorkerStatus({
      strategyId: 'new-token-v1',
      status: 'ok',
      observedAt,
      expiresAt: '2026-06-21T10:01:00.000Z'
    });

    const entries = await pool.listOpenableCandidates('new-token-v1', {
      now: new Date('2026-06-21T10:00:10.000Z'),
      excludedMints,
      limit: 1
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ poolAddress: 'pool-20', tokenMint: 'mint-20' });
    expect(entries[0]?.candidate.safetyScore).toBe(80);
    expect(entries[0]?.candidate.poolFeeYieldScore).toBe(7);
    await pool.close();
  });

  it('marks non-openable missing candidates stale when they disappear from a worker cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-'));
    roots.push(root);
    const path = join(root, 'pool.sqlite');
    const pool = new SqliteCandidatePool({ path });

    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      observedAt: '2026-06-21T10:00:00.000Z',
      sourceObservations: [observation('meteora')]
    });
    await pool.markMissingOpenableStale('new-token-v1', '2026-06-21T10:00:30.000Z', []);
    await pool.close();

    const database = new DatabaseSync(path);
    const row = database.prepare('select status, openable, block_reason from candidate_pool limit 1').get() as {
      status: string;
      openable: number;
      block_reason: string;
    };
    database.close();

    expect(row).toEqual({
      status: 'stale',
      openable: 0,
      block_reason: 'not-seen-this-cycle'
    });
  });

  it('exposes current openable status through worker lease and candidate freshness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-'));
    roots.push(root);
    const path = join(root, 'pool.sqlite');
    const pool = new SqliteCandidatePool({ path });

    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      observedAt: '2026-06-21T10:00:00.000Z',
      sourceObservations: [observation('meteora'), observation('jupiter_route'), observation('gmgn')]
    });
    await pool.writeWorkerStatus({
      strategyId: 'new-token-v1',
      status: 'failed',
      observedAt: '2026-06-21T10:00:05.000Z',
      expiresAt: '2026-06-21T10:00:05.000Z',
      details: 'meteora timeout'
    });
    await pool.close();

    const database = new DatabaseSync(path);
    const row = database.prepare('select status, openable, current_status, current_openable, worker_status from candidate_pool_current limit 1').get() as {
      status: string;
      openable: number;
      current_status: string;
      current_openable: number;
      worker_status: string;
    };
    database.close();

    expect(row).toMatchObject({
      status: 'openable',
      openable: 1,
      current_status: 'source_unavailable',
      current_openable: 0,
      worker_status: 'failed'
    });
  });

  it('keeps fresh candidates readable while the next worker tick is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-running-'));
    roots.push(root);
    const path = join(root, 'pool.sqlite');
    const pool = new SqliteCandidatePool({ path });
    const now = new Date();
    const futureAt = new Date(now.getTime() + 180_000).toISOString();
    const observedAt = now.toISOString();

    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({ capturedAt: observedAt }),
      observedAt,
      sourceObservations: [
        observation('meteora', { observedAt, expiresAt: futureAt }),
        observation('jupiter_route', { observedAt, expiresAt: futureAt }),
        observation('gmgn', { observedAt, expiresAt: futureAt })
      ]
    });
    await pool.writeWorkerStatus({
      strategyId: 'new-token-v1',
      status: 'running',
      observedAt,
      expiresAt: futureAt,
      details: 'candidate-worker-tick-running'
    });

    await expect(pool.listOpenableCandidates('new-token-v1', { now })).resolves.toHaveLength(1);
    const database = new DatabaseSync(path, { readOnly: true });
    const current = database.prepare(`
      SELECT worker_status, current_status, current_openable
      FROM candidate_pool_current
      LIMIT 1
    `).get() as { worker_status: string; current_status: string; current_openable: number };
    database.close();
    expect(current).toEqual({ worker_status: 'running', current_status: 'openable', current_openable: 1 });
    await pool.close();
  });

  it('uses ISO current-time semantics for expired freshness and worker leases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-'));
    roots.push(root);
    const path = join(root, 'pool.sqlite');
    const pool = new SqliteCandidatePool({ path });
    const nowMs = Date.now();
    const observedAt = new Date(nowMs - 120_000).toISOString();
    const expiredAt = new Date(nowMs - 60_000).toISOString();
    const futureAt = new Date(nowMs + 60_000).toISOString();

    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({ address: 'pool-stale-current', mint: 'mint-stale-current', symbol: 'STALE' }),
      observedAt,
      sourceObservations: [
        observation('meteora', { poolAddress: 'pool-stale-current', tokenMint: 'mint-stale-current', observedAt, expiresAt: expiredAt }),
        observation('jupiter_route', { poolAddress: 'pool-stale-current', tokenMint: 'mint-stale-current', observedAt, expiresAt: expiredAt }),
        observation('gmgn', { poolAddress: 'pool-stale-current', tokenMint: 'mint-stale-current', observedAt, expiresAt: expiredAt })
      ]
    });
    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({ address: 'pool-worker-current', mint: 'mint-worker-current', symbol: 'WORKER' }),
      observedAt,
      sourceObservations: [
        observation('meteora', { poolAddress: 'pool-worker-current', tokenMint: 'mint-worker-current', observedAt, expiresAt: futureAt }),
        observation('jupiter_route', { poolAddress: 'pool-worker-current', tokenMint: 'mint-worker-current', observedAt, expiresAt: futureAt }),
        observation('gmgn', { poolAddress: 'pool-worker-current', tokenMint: 'mint-worker-current', observedAt, expiresAt: futureAt })
      ]
    });
    await pool.writeWorkerStatus({
      strategyId: 'new-token-v1',
      status: 'ok',
      observedAt,
      expiresAt: futureAt
    });
    await pool.close();

    const database = new DatabaseSync(path);
    const staleRow = database.prepare(`
      select token_symbol, status, openable, current_status, current_openable, worker_status
      from candidate_pool_current
      where token_symbol='STALE'
    `).get() as {
      token_symbol: string;
      status: string;
      openable: number;
      current_status: string;
      current_openable: number;
      worker_status: string;
    };
    const workerRowBeforeExpiry = database.prepare(`
      select token_symbol, status, openable, current_status, current_openable, worker_status
      from candidate_pool_current
      where token_symbol='WORKER'
    `).get() as {
      token_symbol: string;
      status: string;
      openable: number;
      current_status: string;
      current_openable: number;
      worker_status: string;
    };
    database.prepare(`
      insert into candidate_pool_worker_status (strategy_id, status, observed_at, expires_at, details)
      values (?, ?, ?, ?, ?)
      on conflict(strategy_id) do update set
        status=excluded.status,
        observed_at=excluded.observed_at,
        expires_at=excluded.expires_at,
        details=excluded.details
    `).run('new-token-v1', 'ok', observedAt, expiredAt, 'expired lease');
    const workerRowAfterExpiry = database.prepare(`
      select token_symbol, status, openable, current_status, current_openable, worker_status
      from candidate_pool_current
      where token_symbol='WORKER'
    `).get() as {
      token_symbol: string;
      status: string;
      openable: number;
      current_status: string;
      current_openable: number;
      worker_status: string;
    };
    database.close();

    expect(staleRow).toMatchObject({
      token_symbol: 'STALE',
      status: 'openable',
      openable: 1,
      current_status: 'stale',
      current_openable: 0,
      worker_status: 'ok'
    });
    expect(workerRowBeforeExpiry).toMatchObject({
      token_symbol: 'WORKER',
      status: 'openable',
      openable: 1,
      current_status: 'openable',
      current_openable: 1,
      worker_status: 'ok'
    });
    expect(workerRowAfterExpiry).toMatchObject({
      token_symbol: 'WORKER',
      status: 'openable',
      openable: 1,
      current_status: 'source_unavailable',
      current_openable: 0,
      worker_status: 'ok'
    });
  });

  it('persists pool fee yield samples and blocks retired profiles in candidate selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-yield-'));
    roots.push(root);
    const path = join(root, 'pool.sqlite');
    const pool = new SqliteCandidatePool({ path });
    const row = {
      address: 'pool-1',
      baseMint: 'mint-1',
      baseSymbol: 'SAFE',
      quoteMint: 'So11111111111111111111111111111111111111112',
      tvl: 10_000,
      fees: { '30m': 50, '1h': 100, '2h': 200, '4h': 400, '12h': 900, '24h': 1800 },
      protocol_fees: { '30m': 5, '1h': 10, '2h': 20, '4h': 40, '12h': 90, '24h': 180 },
      volume: { '1h': 10_000 }
    };

    await pool.recordPoolFeeYieldSamples({
      strategyId: 'new-token-v1',
      rows: [row],
      observedAt: new Date('2026-06-21T09:00:00.000Z'),
      sampleIntervalMs: 0
    });
    const profiles = await pool.recordPoolFeeYieldSamples({
      strategyId: 'new-token-v1',
      rows: [{ ...row, tvl: 4_900 }],
      observedAt: new Date('2026-06-21T10:00:00.000Z'),
      sampleIntervalMs: 0
    });
    const profile = profiles.get('pool-1');

    expect(profile?.status).toBe('retired_liquidity_drain');
    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({
        poolFeeYieldStatus: profile?.status,
        poolFeeYieldScore: profile?.score,
        poolFeeYieldReason: profile?.reason
      }),
      observedAt: '2026-06-21T10:00:00.000Z',
      sourceObservations: [
        observation('meteora'),
        observation('jupiter_route'),
        observation('gmgn'),
        observation('pool_fee_yield', {
          status: 'blocked',
          score: 0,
          hardRejectReason: profile?.reason ?? ''
        })
      ]
    });
    await pool.writeWorkerStatus({
      strategyId: 'new-token-v1',
      status: 'ok',
      observedAt: '2026-06-21T10:00:00.000Z',
      expiresAt: '2026-06-21T10:01:00.000Z'
    });
    await expect(pool.selectOpenableCandidate('new-token-v1', {
      now: new Date('2026-06-21T10:00:10.000Z')
    })).resolves.toBeNull();
    await pool.close();
  });

  it('prunes candidate and source rows outside the configured hot retention window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-pool-retention-'));
    roots.push(root);
    const path = join(root, 'pool.sqlite');
    const pool = new SqliteCandidatePool({ path });
    const oldObservedAt = '2026-06-18T10:00:00.000Z';
    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      observedAt: oldObservedAt,
      sourceObservations: [
        observation('meteora', { observedAt: oldObservedAt, expiresAt: '2026-06-18T10:01:00.000Z' }),
        observation('jupiter_route', { observedAt: oldObservedAt, expiresAt: '2026-06-18T10:01:00.000Z' }),
        observation('gmgn', { observedAt: oldObservedAt, expiresAt: '2026-06-18T10:01:00.000Z' })
      ]
    });

    await pool.recordPoolFeeYieldSamples({
      strategyId: 'new-token-v1',
      rows: [],
      observedAt: new Date('2026-06-21T10:00:00.000Z'),
      retentionMs: 48 * 60 * 60_000
    });
    await pool.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const candidateCount = database.prepare('SELECT COUNT(*) AS count FROM candidate_pool').get() as { count: number };
    const observationCount = database.prepare('SELECT COUNT(*) AS count FROM candidate_source_observations').get() as { count: number };
    database.close();
    expect(candidateCount.count).toBe(0);
    expect(observationCount.count).toBe(0);
  });
});
