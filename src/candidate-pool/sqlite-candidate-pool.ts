import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { IngestCandidate } from '../runtime/ingest-candidate-selection.ts';
import type { StrategyId } from '../runtime/live-cycle.ts';
import { deriveCandidatePoolEntry } from './aggregator.ts';
import {
  buildPoolFeeYieldProfile,
  parseMeteoraPoolFeeYieldSample,
  type PoolFeeYieldProfile,
  type PoolFeeYieldSample,
  type PoolFeeYieldStore
} from './pool-fee-yield.ts';
import type {
  CandidatePoolEntry,
  CandidatePoolReader,
  CandidatePoolReaderOptions,
  CandidatePoolUpsert,
  CandidatePoolWriter,
  CandidateSourceObservation
} from './types.ts';

const SCHEMA = [
  `
    CREATE TABLE IF NOT EXISTS candidate_pool (
      strategy_id TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      status TEXT NOT NULL,
      openable INTEGER NOT NULL,
      score REAL NOT NULL,
      block_reason TEXT NOT NULL,
      freshness_expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      raw_candidate_json TEXT NOT NULL,
      PRIMARY KEY (strategy_id, pool_address, token_mint)
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_candidate_pool_openable ON candidate_pool (strategy_id, openable, freshness_expires_at DESC, score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_candidate_pool_updated_at ON candidate_pool (updated_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS candidate_source_observations (
      strategy_id TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      score REAL NOT NULL,
      hard_reject_reason TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (strategy_id, pool_address, token_mint, source)
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_candidate_source_observations_expires_at ON candidate_source_observations (source, expires_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS candidate_pool_worker_status (
      strategy_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      details TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS pool_fee_yield_samples (
      pool_address TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      tvl_usd REAL NOT NULL,
      dynamic_fee_pct REAL NOT NULL,
      net_fee_usd_30m REAL NOT NULL,
      net_fee_usd_1h REAL NOT NULL,
      net_fee_usd_2h REAL NOT NULL,
      net_fee_usd_4h REAL NOT NULL,
      net_fee_usd_12h REAL NOT NULL,
      net_fee_usd_24h REAL NOT NULL,
      net_fee_yield_30m REAL NOT NULL,
      net_fee_yield_1h REAL NOT NULL,
      net_fee_yield_2h REAL NOT NULL,
      net_fee_yield_4h REAL NOT NULL,
      net_fee_yield_12h REAL NOT NULL,
      net_fee_yield_24h REAL NOT NULL,
      volume_usd_1h REAL NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (pool_address, observed_at)
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_pool_fee_yield_samples_pool_time ON pool_fee_yield_samples (pool_address, observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pool_fee_yield_samples_observed_at ON pool_fee_yield_samples (observed_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS pool_fee_yield_profiles (
      pool_address TEXT PRIMARY KEY,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      score REAL NOT NULL,
      reason TEXT NOT NULL,
      tvl_usd REAL NOT NULL,
      tvl_change_1h_pct REAL,
      net_fee_usd_1h REAL NOT NULL,
      net_fee_yield_30m REAL NOT NULL,
      net_fee_yield_1h REAL NOT NULL,
      net_fee_yield_2h REAL NOT NULL,
      net_fee_yield_4h REAL NOT NULL,
      fake_yield_reason TEXT NOT NULL,
      retired_until TEXT,
      raw_json TEXT NOT NULL
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_pool_fee_yield_profiles_score ON pool_fee_yield_profiles (status, score DESC, observed_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS pool_fee_yield_retirements (
      pool_address TEXT PRIMARY KEY,
      token_mint TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      retired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_pool_fee_yield_retirements_expires_at ON pool_fee_yield_retirements (expires_at DESC)`,
  `DROP VIEW IF EXISTS candidate_pool_current`,
  `
    CREATE VIEW candidate_pool_current AS
    SELECT
      candidate_pool.*,
      candidate_pool_worker_status.status AS worker_status,
      candidate_pool_worker_status.observed_at AS worker_observed_at,
      candidate_pool_worker_status.expires_at AS worker_expires_at,
      CASE
        WHEN candidate_pool_worker_status.strategy_id IS NULL THEN 'source_unavailable'
        WHEN candidate_pool_worker_status.status != 'ok' THEN 'source_unavailable'
        WHEN candidate_pool_worker_status.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 'source_unavailable'
        WHEN candidate_pool.freshness_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 'stale'
        ELSE candidate_pool.status
      END AS current_status,
      CASE
        WHEN candidate_pool_worker_status.strategy_id IS NULL THEN 0
        WHEN candidate_pool_worker_status.status != 'ok' THEN 0
        WHEN candidate_pool_worker_status.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 0
        WHEN candidate_pool.freshness_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 0
        ELSE candidate_pool.openable
      END AS current_openable
    FROM candidate_pool
    LEFT JOIN candidate_pool_worker_status
      ON candidate_pool_worker_status.strategy_id = candidate_pool.strategy_id
  `
] as const;

type Row = Record<string, unknown>;

function readString(row: Row, key: string) {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(row: Row, key: string) {
  const value = row[key];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function readBoolean(row: Row, key: string) {
  return Boolean(row[key]);
}

function parseCandidate(rawJson: string): IngestCandidate | null {
  try {
    return JSON.parse(rawJson) as IngestCandidate;
  } catch {
    return null;
  }
}

export class SqliteCandidatePool implements CandidatePoolReader, CandidatePoolWriter, PoolFeeYieldStore {
  private readonly path: string;
  private readonly readOnly: boolean;
  private readonly busyTimeoutMs: number;
  private database?: DatabaseSync;

  constructor(options: { path: string; readOnly?: boolean; busyTimeoutMs?: number }) {
    this.path = options.path;
    this.readOnly = options.readOnly ?? false;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 1000;
  }

  async open() {
    if (this.database) {
      return;
    }

    if (this.readOnly && !existsSync(this.path)) {
      return;
    }

    if (!this.readOnly) {
      await mkdir(dirname(this.path), { recursive: true });
    }

    const database = new DatabaseSync(this.path, this.readOnly ? { readOnly: true } : {});
    database.exec(`
      PRAGMA busy_timeout = ${this.busyTimeoutMs};
      PRAGMA temp_store = MEMORY;
    `);

    if (!this.readOnly) {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
      `);
      for (const statement of SCHEMA) {
        database.exec(statement);
      }
    }

    this.database = database;
  }

  async close() {
    this.database?.close();
    this.database = undefined;
  }

  private db() {
    if (!this.database) {
      throw new Error('candidate pool database is not open');
    }
    return this.database;
  }

  async upsertCandidate(input: CandidatePoolUpsert): Promise<CandidatePoolEntry> {
    await this.open();
    const database = this.db();
    const existing = this.readObservations(database, input.strategyId, input.candidate.address, input.candidate.mint)
      .filter((observation) => !input.sourceObservations.some((item) => item.source === observation.source));
    const observations = [...existing, ...input.sourceObservations];
    const entry = deriveCandidatePoolEntry({
      strategyId: input.strategyId,
      candidate: input.candidate,
      observations,
      now: new Date(input.observedAt)
    });

    database.exec('BEGIN IMMEDIATE');
    try {
      const sourceStmt = database.prepare(`
        INSERT INTO candidate_source_observations (
          strategy_id, pool_address, token_mint, source, status, observed_at, expires_at,
          latency_ms, score, hard_reject_reason, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(strategy_id, pool_address, token_mint, source) DO UPDATE SET
          status=excluded.status,
          observed_at=excluded.observed_at,
          expires_at=excluded.expires_at,
          latency_ms=excluded.latency_ms,
          score=excluded.score,
          hard_reject_reason=excluded.hard_reject_reason,
          raw_json=excluded.raw_json
      `);

      for (const observation of input.sourceObservations) {
        sourceStmt.run(
          observation.strategyId,
          observation.poolAddress,
          observation.tokenMint,
          observation.source,
          observation.status,
          observation.observedAt,
          observation.expiresAt,
          Math.round(observation.latencyMs),
          observation.score,
          observation.hardRejectReason,
          JSON.stringify(observation.rawJson)
        );
      }

      database.prepare(`
        INSERT INTO candidate_pool (
          strategy_id, pool_address, token_mint, token_symbol, status, openable, score,
          block_reason, freshness_expires_at, updated_at, raw_candidate_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(strategy_id, pool_address, token_mint) DO UPDATE SET
          token_symbol=excluded.token_symbol,
          status=excluded.status,
          openable=excluded.openable,
          score=excluded.score,
          block_reason=excluded.block_reason,
          freshness_expires_at=excluded.freshness_expires_at,
          updated_at=excluded.updated_at,
          raw_candidate_json=excluded.raw_candidate_json
      `).run(
        entry.strategyId,
        entry.poolAddress,
        entry.tokenMint,
        entry.tokenSymbol,
        entry.status,
        entry.openable ? 1 : 0,
        entry.score,
        entry.blockReason,
        entry.freshnessExpiresAt,
        entry.updatedAt,
        JSON.stringify(entry.candidate)
      );
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return entry;
  }

  async markMissingOpenableStale(strategyId: StrategyId, observedAt: string, seenKeys: Array<{ poolAddress: string; tokenMint: string }>) {
    await this.open();
    const database = this.db();
    if (seenKeys.length === 0) {
      database.prepare(`
        UPDATE candidate_pool
        SET status='stale', openable=0, block_reason='not-seen-this-cycle', updated_at=?
        WHERE strategy_id=? AND status!='stale'
      `).run(observedAt, strategyId);
      return;
    }

    const keep = new Set(seenKeys.map((key) => `${key.poolAddress}:${key.tokenMint}`));
    const rows = database.prepare(`
      SELECT pool_address, token_mint FROM candidate_pool WHERE strategy_id=? AND status!='stale'
    `).all(strategyId) as Row[];
    const stale = rows.filter((row) => !keep.has(`${readString(row, 'pool_address')}:${readString(row, 'token_mint')}`));
    const stmt = database.prepare(`
      UPDATE candidate_pool
      SET status='stale', openable=0, block_reason='not-seen-this-cycle', updated_at=?
      WHERE strategy_id=? AND pool_address=? AND token_mint=?
    `);
    for (const row of stale) {
      stmt.run(observedAt, strategyId, readString(row, 'pool_address'), readString(row, 'token_mint'));
    }
  }

  async writeWorkerStatus(input: {
    strategyId: StrategyId;
    status: 'running' | 'ok' | 'failed';
    observedAt: string;
    expiresAt: string;
    details?: string;
  }) {
    await this.open();
    const database = this.db();
    database.prepare(`
      INSERT INTO candidate_pool_worker_status (
        strategy_id, status, observed_at, expires_at, details
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(strategy_id) DO UPDATE SET
        status=excluded.status,
        observed_at=excluded.observed_at,
        expires_at=excluded.expires_at,
        details=excluded.details
    `).run(
      input.strategyId,
      input.status,
      input.observedAt,
      input.expiresAt,
      input.details ?? ''
    );
  }

  async recordPoolFeeYieldSamples(input: {
    strategyId: StrategyId;
    rows: Record<string, unknown>[];
    observedAt: Date;
    sampleIntervalMs?: number;
    minTvlUsd?: number;
    retirementMs?: number;
    retentionMs?: number;
  }): Promise<Map<string, PoolFeeYieldProfile>> {
    await this.open();
    if (!this.database || this.readOnly) {
      return new Map();
    }

    const database = this.db();
    const nowIso = input.observedAt.toISOString();
    const sampleIntervalMs = input.sampleIntervalMs ?? 5 * 60 * 1000;
    const retentionMs = input.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    const profiles = new Map<string, PoolFeeYieldProfile>();
    const samples = input.rows
      .map((row) => parseMeteoraPoolFeeYieldSample(row, input.observedAt))
      .filter((sample): sample is PoolFeeYieldSample => Boolean(sample));

    database.exec('BEGIN IMMEDIATE');
    try {
      for (const sample of samples) {
        const activeRetirement = this.readActivePoolFeeYieldRetirement(database, sample.poolAddress, nowIso);
        if (activeRetirement) {
          const profile = this.readPoolFeeYieldProfile(database, sample.poolAddress)
            ?? this.retirementToProfile(sample, activeRetirement);
          profiles.set(sample.poolAddress, profile);
          continue;
        }

        const lastObservedAt = this.readLatestPoolFeeYieldSampleObservedAt(database, sample.poolAddress);
        if (lastObservedAt) {
          const ageMs = input.observedAt.getTime() - Date.parse(lastObservedAt);
          if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < sampleIntervalMs) {
            const profile = this.readPoolFeeYieldProfile(database, sample.poolAddress);
            if (profile) {
              profiles.set(sample.poolAddress, profile);
            }
            continue;
          }
        }

        const previousTvlUsd = this.readReferencePoolFeeYieldTvl(database, sample.poolAddress, input.observedAt);
        const profile = buildPoolFeeYieldProfile({
          sample,
          previousTvlUsd,
          minTvlUsd: input.minTvlUsd,
          retirementMs: input.retirementMs
        });
        this.insertPoolFeeYieldSample(database, sample);
        this.upsertPoolFeeYieldProfile(database, profile);
        if (profile.status === 'retired_liquidity_drain' && profile.retiredUntil) {
          this.upsertPoolFeeYieldRetirement(database, profile);
        }
        profiles.set(sample.poolAddress, profile);
      }

      const retentionCutoff = new Date(input.observedAt.getTime() - retentionMs).toISOString();
      database.prepare('DELETE FROM pool_fee_yield_samples WHERE observed_at < ?').run(retentionCutoff);
      database.prepare('DELETE FROM pool_fee_yield_retirements WHERE expires_at < ?').run(nowIso);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    return profiles;
  }

  private hasFreshOkWorker(strategyId: StrategyId, now: Date) {
    const row = this.db().prepare(`
      SELECT status, expires_at FROM candidate_pool_worker_status WHERE strategy_id=?
    `).get(strategyId) as Row | undefined;
    if (!row) {
      return false;
    }

    return readString(row, 'status') === 'ok' && readString(row, 'expires_at') > now.toISOString();
  }

  async selectOpenableCandidate(strategyId: StrategyId, options: CandidatePoolReaderOptions = {}): Promise<CandidatePoolEntry | null> {
    await this.open();
    if (!this.database) {
      return null;
    }

    const now = options.now ?? new Date();
    if (options.requireFreshWorker !== false && !this.hasFreshOkWorker(strategyId, now)) {
      return null;
    }

    const excluded = new Set(options.excludedMints ?? []);
    const excludedTargets = new Set(
      (options.excludedTargets ?? [])
        .map((target) => `${target.poolAddress ?? ''}::${target.tokenMint ?? ''}`)
    );
    const rows = this.database.prepare(`
      SELECT * FROM candidate_pool
      WHERE strategy_id=?
        AND openable=1
        AND freshness_expires_at > ?
      ORDER BY score DESC, updated_at DESC
      LIMIT 20
    `).all(strategyId, now.toISOString()) as Row[];

    for (const candidateRow of rows) {
      const mint = readString(candidateRow, 'token_mint');
      if (excluded.has(mint)) {
        continue;
      }
      const poolAddress = readString(candidateRow, 'pool_address');
      if (
        excludedTargets.has(`${poolAddress}::${mint}`) ||
        excludedTargets.has(`::${mint}`) ||
        excludedTargets.has(`${poolAddress}::`)
      ) {
        continue;
      }
      const candidate = parseCandidate(readString(candidateRow, 'raw_candidate_json'));
      if (!candidate) {
        continue;
      }

      const updatedAt = readString(candidateRow, 'updated_at');
      if (typeof options.maxAgeMs === 'number' && options.maxAgeMs >= 0) {
        const ageMs = now.getTime() - Date.parse(updatedAt);
        if (!Number.isFinite(ageMs) || ageMs > options.maxAgeMs) {
          continue;
        }
      }

      return {
        strategyId: readString(candidateRow, 'strategy_id') as StrategyId,
        poolAddress,
        tokenMint: mint,
        tokenSymbol: readString(candidateRow, 'token_symbol'),
        status: readString(candidateRow, 'status') as CandidatePoolEntry['status'],
        openable: readBoolean(candidateRow, 'openable'),
        score: readNumber(candidateRow, 'score'),
        blockReason: readString(candidateRow, 'block_reason'),
        freshnessExpiresAt: readString(candidateRow, 'freshness_expires_at'),
        updatedAt,
        candidate: {
          ...candidate,
          safetyScore: readNumber(candidateRow, 'score')
        }
      };
    }

    return null;
  }

  private readObservations(database: DatabaseSync, strategyId: StrategyId, poolAddress: string, tokenMint: string) {
    const rows = database.prepare(`
      SELECT * FROM candidate_source_observations
      WHERE strategy_id=? AND pool_address=? AND token_mint=?
    `).all(strategyId, poolAddress, tokenMint) as Row[];

    return rows.map((row) => ({
      strategyId: readString(row, 'strategy_id') as StrategyId,
      poolAddress: readString(row, 'pool_address'),
      tokenMint: readString(row, 'token_mint'),
      source: readString(row, 'source') as CandidateSourceObservation['source'],
      status: readString(row, 'status') as CandidateSourceObservation['status'],
      observedAt: readString(row, 'observed_at'),
      expiresAt: readString(row, 'expires_at'),
      latencyMs: readNumber(row, 'latency_ms'),
      score: readNumber(row, 'score'),
      hardRejectReason: readString(row, 'hard_reject_reason'),
      rawJson: (() => {
        try {
          return JSON.parse(readString(row, 'raw_json')) as Record<string, unknown>;
        } catch {
          return {};
        }
      })()
    }));
  }

  private readLatestPoolFeeYieldSampleObservedAt(database: DatabaseSync, poolAddress: string) {
    const row = database.prepare(`
      SELECT observed_at FROM pool_fee_yield_samples
      WHERE pool_address=?
      ORDER BY observed_at DESC
      LIMIT 1
    `).get(poolAddress) as Row | undefined;
    return row ? readString(row, 'observed_at') : '';
  }

  private readReferencePoolFeeYieldTvl(database: DatabaseSync, poolAddress: string, observedAt: Date) {
    const minAt = new Date(observedAt.getTime() - 75 * 60 * 1000).toISOString();
    const maxAt = new Date(observedAt.getTime() - 30 * 60 * 1000).toISOString();
    const row = database.prepare(`
      SELECT tvl_usd FROM pool_fee_yield_samples
      WHERE pool_address=? AND observed_at >= ? AND observed_at <= ?
      ORDER BY observed_at DESC
      LIMIT 1
    `).get(poolAddress, minAt, maxAt) as Row | undefined;
    return row ? readNumber(row, 'tvl_usd') : null;
  }

  private readActivePoolFeeYieldRetirement(database: DatabaseSync, poolAddress: string, nowIso: string) {
    return database.prepare(`
      SELECT * FROM pool_fee_yield_retirements
      WHERE pool_address=? AND expires_at > ?
      LIMIT 1
    `).get(poolAddress, nowIso) as Row | undefined;
  }

  private readPoolFeeYieldProfile(database: DatabaseSync, poolAddress: string): PoolFeeYieldProfile | null {
    const row = database.prepare(`
      SELECT * FROM pool_fee_yield_profiles WHERE pool_address=?
    `).get(poolAddress) as Row | undefined;
    if (!row) {
      return null;
    }
    return {
      poolAddress: readString(row, 'pool_address'),
      tokenMint: readString(row, 'token_mint'),
      tokenSymbol: readString(row, 'token_symbol'),
      observedAt: readString(row, 'observed_at'),
      status: readString(row, 'status') as PoolFeeYieldProfile['status'],
      score: readNumber(row, 'score'),
      reason: readString(row, 'reason'),
      tvlUsd: readNumber(row, 'tvl_usd'),
      tvlChange1hPct: row.tvl_change_1h_pct === null ? null : readNumber(row, 'tvl_change_1h_pct'),
      netFeeUsd1h: readNumber(row, 'net_fee_usd_1h'),
      netFeeYield30m: readNumber(row, 'net_fee_yield_30m'),
      netFeeYield1h: readNumber(row, 'net_fee_yield_1h'),
      netFeeYield2h: readNumber(row, 'net_fee_yield_2h'),
      netFeeYield4h: readNumber(row, 'net_fee_yield_4h'),
      currentYield1h: readNumber(row, 'net_fee_yield_1h'),
      prevHourYield: 0,
      recent30mYield: readNumber(row, 'net_fee_yield_30m'),
      prev30mYield: 0,
      fakeYieldReason: readString(row, 'fake_yield_reason'),
      retiredUntil: readString(row, 'retired_until') || undefined
    };
  }

  private retirementToProfile(sample: PoolFeeYieldSample, retirement: Row): PoolFeeYieldProfile {
    return {
      poolAddress: sample.poolAddress,
      tokenMint: sample.tokenMint,
      tokenSymbol: sample.tokenSymbol,
      observedAt: sample.observedAt,
      status: 'retired_liquidity_drain',
      score: 0,
      reason: readString(retirement, 'reason') || 'pool-fee-yield-retired',
      tvlUsd: sample.tvlUsd,
      tvlChange1hPct: null,
      netFeeUsd1h: sample.netFeesUsd['1h'],
      netFeeYield30m: sample.netFeeYield['30m'],
      netFeeYield1h: sample.netFeeYield['1h'],
      netFeeYield2h: sample.netFeeYield['2h'],
      netFeeYield4h: sample.netFeeYield['4h'],
      currentYield1h: sample.netFeeYield['1h'],
      prevHourYield: 0,
      recent30mYield: sample.netFeeYield['30m'],
      prev30mYield: 0,
      fakeYieldReason: '',
      retiredUntil: readString(retirement, 'expires_at') || undefined
    };
  }

  private insertPoolFeeYieldSample(database: DatabaseSync, sample: PoolFeeYieldSample) {
    database.prepare(`
      INSERT OR REPLACE INTO pool_fee_yield_samples (
        pool_address, token_mint, token_symbol, observed_at, tvl_usd, dynamic_fee_pct,
        net_fee_usd_30m, net_fee_usd_1h, net_fee_usd_2h, net_fee_usd_4h, net_fee_usd_12h, net_fee_usd_24h,
        net_fee_yield_30m, net_fee_yield_1h, net_fee_yield_2h, net_fee_yield_4h, net_fee_yield_12h, net_fee_yield_24h,
        volume_usd_1h, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sample.poolAddress,
      sample.tokenMint,
      sample.tokenSymbol,
      sample.observedAt,
      sample.tvlUsd,
      sample.dynamicFeePct,
      sample.netFeesUsd['30m'],
      sample.netFeesUsd['1h'],
      sample.netFeesUsd['2h'],
      sample.netFeesUsd['4h'],
      sample.netFeesUsd['12h'],
      sample.netFeesUsd['24h'],
      sample.netFeeYield['30m'],
      sample.netFeeYield['1h'],
      sample.netFeeYield['2h'],
      sample.netFeeYield['4h'],
      sample.netFeeYield['12h'],
      sample.netFeeYield['24h'],
      sample.volumeUsd['1h'],
      JSON.stringify(sample.rawJson)
    );
  }

  private upsertPoolFeeYieldProfile(database: DatabaseSync, profile: PoolFeeYieldProfile) {
    database.prepare(`
      INSERT INTO pool_fee_yield_profiles (
        pool_address, token_mint, token_symbol, observed_at, status, score, reason,
        tvl_usd, tvl_change_1h_pct, net_fee_usd_1h,
        net_fee_yield_30m, net_fee_yield_1h, net_fee_yield_2h, net_fee_yield_4h,
        fake_yield_reason, retired_until, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pool_address) DO UPDATE SET
        token_mint=excluded.token_mint,
        token_symbol=excluded.token_symbol,
        observed_at=excluded.observed_at,
        status=excluded.status,
        score=excluded.score,
        reason=excluded.reason,
        tvl_usd=excluded.tvl_usd,
        tvl_change_1h_pct=excluded.tvl_change_1h_pct,
        net_fee_usd_1h=excluded.net_fee_usd_1h,
        net_fee_yield_30m=excluded.net_fee_yield_30m,
        net_fee_yield_1h=excluded.net_fee_yield_1h,
        net_fee_yield_2h=excluded.net_fee_yield_2h,
        net_fee_yield_4h=excluded.net_fee_yield_4h,
        fake_yield_reason=excluded.fake_yield_reason,
        retired_until=excluded.retired_until,
        raw_json=excluded.raw_json
    `).run(
      profile.poolAddress,
      profile.tokenMint,
      profile.tokenSymbol,
      profile.observedAt,
      profile.status,
      profile.score,
      profile.reason,
      profile.tvlUsd,
      profile.tvlChange1hPct,
      profile.netFeeUsd1h,
      profile.netFeeYield30m,
      profile.netFeeYield1h,
      profile.netFeeYield2h,
      profile.netFeeYield4h,
      profile.fakeYieldReason,
      profile.retiredUntil ?? null,
      JSON.stringify(profile)
    );
  }

  private upsertPoolFeeYieldRetirement(database: DatabaseSync, profile: PoolFeeYieldProfile) {
    database.prepare(`
      INSERT INTO pool_fee_yield_retirements (
        pool_address, token_mint, status, reason, retired_at, expires_at, last_observed_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pool_address) DO UPDATE SET
        token_mint=excluded.token_mint,
        status=excluded.status,
        reason=excluded.reason,
        retired_at=excluded.retired_at,
        expires_at=excluded.expires_at,
        last_observed_at=excluded.last_observed_at,
        raw_json=excluded.raw_json
    `).run(
      profile.poolAddress,
      profile.tokenMint,
      profile.status,
      profile.reason,
      profile.observedAt,
      profile.retiredUntil ?? profile.observedAt,
      profile.observedAt,
      JSON.stringify(profile)
    );
  }
}
