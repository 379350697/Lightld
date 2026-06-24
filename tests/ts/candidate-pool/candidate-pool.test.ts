import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveCandidatePoolEntry } from '../../../src/candidate-pool/aggregator';
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
  it('marks candidates openable when hard sources are fresh and passed', () => {
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [observation('meteora'), observation('jupiter_route')]
    });

    expect(entry.status).toBe('openable');
    expect(entry.openable).toBe(true);
    expect(entry.blockReason).toBe('');
  });

  it('lets a missing GMGN soft source leave a hard-source candidate openable', () => {
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate(),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [observation('meteora'), observation('jupiter_route')]
    });

    expect(entry.status).toBe('openable');
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

  it('blocks on a fresh explicit GMGN rejection but ignores stale GMGN rejections', () => {
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
    expect(staleGmgn.status).toBe('openable');
  });

  it('blocks bad pool fee yield profiles without making fee yield a hard dependency', () => {
    const missingProfile = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({ poolFeeYieldStatus: 'yield_profile_missing' }),
      now: new Date('2026-06-21T10:00:00.000Z'),
      observations: [
        observation('meteora'),
        observation('jupiter_route'),
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

  it('keeps score bounded when fee/tvl source uses percent-like units', () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    const candidate = makeCandidate({ feeTvlRatio24h: 307.81 });
    const entry = deriveCandidatePoolEntry({
      strategyId: 'new-token-v1',
      candidate,
      now,
      observations: [
        buildMeteoraObservation({ strategyId: 'new-token-v1', candidate, now, ttlMs: 60_000 }),
        buildRouteObservation({ strategyId: 'new-token-v1', candidate, now, ttlMs: 60_000, routeExists: true })
      ]
    });

    expect(entry.status).toBe('openable');
    expect(entry.score).toBeLessThanOrEqual(150);
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
      sourceObservations: [observation('meteora'), observation('jupiter_route')]
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
      sourceObservations: [observation('meteora'), observation('jupiter_route')]
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
        observation('jupiter_route', { poolAddress: 'pool-stale-current', tokenMint: 'mint-stale-current', observedAt, expiresAt: expiredAt })
      ]
    });
    await pool.upsertCandidate({
      strategyId: 'new-token-v1',
      candidate: makeCandidate({ address: 'pool-worker-current', mint: 'mint-worker-current', symbol: 'WORKER' }),
      observedAt,
      sourceObservations: [
        observation('meteora', { poolAddress: 'pool-worker-current', tokenMint: 'mint-worker-current', observedAt, expiresAt: futureAt }),
        observation('jupiter_route', { poolAddress: 'pool-worker-current', tokenMint: 'mint-worker-current', observedAt, expiresAt: futureAt })
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
});
