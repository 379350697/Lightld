import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { LiveCycleOutcomeRecord } from '../evolution/types.ts';
import type {
  CaptureResearchSnapshotInput,
  ResearchEpisode,
  ResearchMark,
  StrategyResearchSpec
} from './types.ts';

const HORIZONS = [15, 60, 240, 1440] as const;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS experiments (
    experiment_id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    stopped_at TEXT,
    spec_json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_experiment ON experiments(status) WHERE status='active';
  CREATE TABLE IF NOT EXISTS snapshots (
    snapshot_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    capture_mode TEXT NOT NULL,
    candidates_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_research_snapshots_time ON snapshots(experiment_id, observed_at);
  CREATE TABLE IF NOT EXISTS decisions (
    snapshot_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    selected INTEGER NOT NULL,
    eligible INTEGER NOT NULL,
    reason TEXT NOT NULL,
    position_sol REAL NOT NULL,
    PRIMARY KEY(snapshot_id, variant_id, pool_address, token_mint)
  );
  CREATE TABLE IF NOT EXISTS episodes (
    episode_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    experiment_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    token_symbol TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    position_sol REAL NOT NULL,
    selected INTEGER NOT NULL,
    features_json TEXT NOT NULL,
    target_token_raw TEXT,
    double_token_raw TEXT,
    entry_target_impact_bps REAL,
    entry_double_impact_bps REAL,
    entry_status TEXT,
    entry_detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_research_episodes_due ON episodes(experiment_id, observed_at);
  CREATE TABLE IF NOT EXISTS marks (
    episode_id TEXT NOT NULL,
    horizon_minutes INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    status TEXT NOT NULL,
    target_recovery_sol REAL,
    double_recovery_sol REAL,
    target_impact_bps REAL,
    double_impact_bps REAL,
    detail TEXT NOT NULL,
    PRIMARY KEY(episode_id, horizon_minutes)
  );
  CREATE TABLE IF NOT EXISTS paper_outcomes (
    outcome_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    opened_at TEXT,
    closed_at TEXT,
    runtime_mode TEXT NOT NULL,
    capture_mode TEXT NOT NULL DEFAULT 'unknown',
    entry_sol REAL,
    exit_value_sol REAL,
    fee_value_sol REAL,
    pnl_sol REAL,
    raw_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    report_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    report_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worker_status (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    heartbeat_at TEXT NOT NULL,
    status TEXT NOT NULL,
    due_count INTEGER NOT NULL,
    completed_count INTEGER NOT NULL,
    unavailable_count INTEGER NOT NULL
  );
`;

type Row = Record<string, unknown>;

export class StrategyResearchStore {
  private database?: DatabaseSync;
  readonly path: string;
  private readonly readOnly: boolean;

  constructor(path: string, readOnly = false) {
    this.path = path;
    this.readOnly = readOnly;
  }

  async open() {
    if (this.database) return;
    if (this.readOnly && !existsSync(this.path)) return;
    if (!this.readOnly) await mkdir(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path, this.readOnly ? { readOnly: true } : {});
    database.exec('PRAGMA busy_timeout=2000; PRAGMA temp_store=MEMORY;');
    if (!this.readOnly) {
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
      database.exec(SCHEMA);
      ensureColumn(database, 'paper_outcomes', 'capture_mode', "TEXT NOT NULL DEFAULT 'unknown'");
    }
    this.database = database;
  }

  close() {
    this.database?.close();
    this.database = undefined;
  }

  startExperiment(spec: StrategyResearchSpec, startedAt = new Date().toISOString()) {
    const database = this.required();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare("UPDATE experiments SET status='stopped', stopped_at=? WHERE status='active' AND experiment_id<>?")
        .run(startedAt, spec.experimentId);
      const existing = database.prepare('SELECT spec_json AS specJson FROM experiments WHERE experiment_id=?')
        .get(spec.experimentId) as { specJson?: string } | undefined;
      if (existing?.specJson && stableJson(JSON.parse(existing.specJson)) !== stableJson(spec)) {
        throw new Error(`Experiment ${spec.experimentId} already exists with a different spec`);
      }
      database.prepare(`
        INSERT INTO experiments(experiment_id,strategy_id,status,started_at,stopped_at,spec_json)
        VALUES(?,?,'active',?,NULL,?)
        ON CONFLICT(experiment_id) DO UPDATE SET status='active', stopped_at=NULL
      `).run(spec.experimentId, spec.strategyId, startedAt, stableJson(spec));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  stopExperiment(stoppedAt = new Date().toISOString()) {
    return this.required().prepare("UPDATE experiments SET status='stopped', stopped_at=? WHERE status='active'").run(stoppedAt).changes;
  }

  activeExperiment(): StrategyResearchSpec | null {
    const row = this.required().prepare("SELECT spec_json AS specJson FROM experiments WHERE status='active' LIMIT 1").get() as { specJson?: string } | undefined;
    return row?.specJson ? JSON.parse(row.specJson) as StrategyResearchSpec : null;
  }

  experiment(experimentId: string): StrategyResearchSpec | null {
    const row = this.required().prepare('SELECT spec_json AS specJson FROM experiments WHERE experiment_id=?').get(experimentId) as { specJson?: string } | undefined;
    return row?.specJson ? JSON.parse(row.specJson) as StrategyResearchSpec : null;
  }

  latestExperiment(): { spec: StrategyResearchSpec; status: string } | null {
    const row = this.required().prepare(`
      SELECT spec_json AS specJson,status FROM experiments ORDER BY started_at DESC LIMIT 1
    `).get() as { specJson?: string; status?: string } | undefined;
    return row?.specJson ? { spec: JSON.parse(row.specJson) as StrategyResearchSpec, status: row.status ?? 'unknown' } : null;
  }

  hasRecentSnapshot(experimentId: string, observedAt: string, intervalMs = 15 * 60_000) {
    const row = this.required().prepare(`
      SELECT observed_at AS observedAt FROM snapshots WHERE experiment_id=? ORDER BY observed_at DESC LIMIT 1
    `).get(experimentId) as { observedAt?: string } | undefined;
    if (!row?.observedAt) return false;
    const elapsed = Date.parse(observedAt) - Date.parse(row.observedAt);
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < intervalMs;
  }

  captureSnapshot(input: CaptureResearchSnapshotInput) {
    const database = this.required();
    const byCandidate = new Map(input.candidates.map((candidate) => [`${candidate.poolAddress}\0${candidate.tokenMint}`, candidate]));
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = database.prepare('SELECT candidates_json AS candidatesJson FROM snapshots WHERE snapshot_id=?').get(input.snapshotId) as { candidatesJson?: string } | undefined;
      const candidatesJson = stableJson(input.candidates);
      if (existing?.candidatesJson && existing.candidatesJson !== candidatesJson) {
        throw new Error(`Conflicting research snapshot ${input.snapshotId}`);
      }
      database.prepare(`
        INSERT OR IGNORE INTO snapshots(snapshot_id,experiment_id,strategy_id,observed_at,capture_mode,candidates_json)
        VALUES(?,?,?,?,?,?)
      `).run(input.snapshotId, input.experimentId, input.strategyId, input.observedAt, input.captureMode, candidatesJson);
      const insertDecision = database.prepare(`
        INSERT OR IGNORE INTO decisions(snapshot_id,variant_id,pool_address,token_mint,selected,eligible,reason,position_sol)
        VALUES(?,?,?,?,?,?,?,?)
      `);
      const insertEpisode = database.prepare(`
        INSERT OR IGNORE INTO episodes(
          episode_id,snapshot_id,experiment_id,strategy_id,variant_id,pool_address,token_mint,token_symbol,
          observed_at,position_sol,selected,features_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const decision of input.decisions) {
        insertDecision.run(
          input.snapshotId, decision.variantId, decision.poolAddress, decision.tokenMint,
          Number(decision.selected), Number(decision.eligible), decision.reason, decision.positionSol
        );
        if (!decision.selected) continue;
        const candidate = byCandidate.get(`${decision.poolAddress}\0${decision.tokenMint}`);
        if (!candidate) throw new Error('Research decision references a missing candidate');
        const episodeId = hashId('episode', input.snapshotId, decision.variantId, decision.poolAddress, decision.tokenMint);
        const observedAtMs = Date.parse(input.observedAt);
        if (!Number.isFinite(observedAtMs)) throw new Error(`Invalid research observation time: ${input.observedAt}`);
        const nonOverlapCutoff = new Date(observedAtMs - 24 * 60 * 60_000).toISOString();
        const overlaps = database.prepare(`
          SELECT 1 FROM episodes
          WHERE experiment_id=? AND variant_id=? AND pool_address=? AND token_mint=?
            AND observed_at>? AND observed_at<=?
          LIMIT 1
        `).get(
          input.experimentId, decision.variantId, decision.poolAddress, decision.tokenMint,
          nonOverlapCutoff, input.observedAt
        );
        if (overlaps) continue;
        insertEpisode.run(
          episodeId, input.snapshotId, input.experimentId, input.strategyId, decision.variantId,
          decision.poolAddress, decision.tokenMint, candidate.tokenSymbol, input.observedAt,
          decision.positionSol, Number(decision.selected), stableJson(candidate.features)
        );
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  dueEpisodes(now = new Date(), limit = 100): Array<{ episode: ResearchEpisode; horizonMinutes: 0 | 15 | 60 | 240 | 1440 }> {
    const rows = this.required().prepare(`
      SELECT e.*, GROUP_CONCAT(m.horizon_minutes) AS completed_horizons
      FROM episodes e LEFT JOIN marks m ON m.episode_id=e.episode_id
      GROUP BY e.episode_id ORDER BY e.observed_at ASC
    `).all() as Row[];
    const due: Array<{ episode: ResearchEpisode; horizonMinutes: 0 | 15 | 60 | 240 | 1440 }> = [];
    const scheduled = new Set<string>();
    for (const row of rows) {
      const episode = mapEpisode(row);
      const entryStatus = row.entry_status === null || row.entry_status === undefined ? '' : String(row.entry_status);
      if ((!episode.targetTokenRaw || !episode.doubleTokenRaw) && (entryStatus === '' || entryStatus === 'unavailable')) {
        const key = `${episode.snapshotId}:${episode.poolAddress}:${episode.tokenMint}:0`;
        if (!scheduled.has(key)) {
          scheduled.add(key);
          due.push({ episode, horizonMinutes: 0 });
        }
      } else if (episode.targetTokenRaw && episode.doubleTokenRaw) {
        const completed = new Set(String(row.completed_horizons ?? '').split(',').filter(Boolean).map(Number));
        const ageMinutes = (now.getTime() - Date.parse(episode.observedAt)) / 60_000;
        const horizon = HORIZONS.find((value) => ageMinutes >= value && !completed.has(value));
        if (horizon) {
          const key = `${episode.snapshotId}:${episode.poolAddress}:${episode.tokenMint}:${horizon}`;
          if (!scheduled.has(key)) {
            scheduled.add(key);
            due.push({ episode, horizonMinutes: horizon });
          }
        }
      }
      if (due.length >= limit) break;
    }
    return due;
  }

  recordEntryQuote(input: {
    episodeId: string;
    status: string;
    targetTokenRaw?: string;
    doubleTokenRaw?: string;
    targetImpactBps?: number | null;
    doubleImpactBps?: number | null;
    detail?: string;
  }) {
    this.required().prepare(`
      UPDATE episodes SET target_token_raw=?,double_token_raw=?,entry_target_impact_bps=?,entry_double_impact_bps=?,entry_status=?,entry_detail=?
      WHERE snapshot_id=(SELECT snapshot_id FROM episodes WHERE episode_id=?)
        AND pool_address=(SELECT pool_address FROM episodes WHERE episode_id=?)
        AND token_mint=(SELECT token_mint FROM episodes WHERE episode_id=?)
    `).run(
      input.targetTokenRaw ?? null, input.doubleTokenRaw ?? null, input.targetImpactBps ?? null,
      input.doubleImpactBps ?? null, input.status, input.detail ?? '', input.episodeId, input.episodeId, input.episodeId
    );
  }

  recordMark(mark: ResearchMark) {
    this.required().prepare(`
      INSERT INTO marks(episode_id,horizon_minutes,observed_at,status,target_recovery_sol,double_recovery_sol,target_impact_bps,double_impact_bps,detail)
      SELECT grouped.episode_id,?,?,?,?,?,?,?,?
      FROM episodes source JOIN episodes grouped
        ON grouped.snapshot_id=source.snapshot_id AND grouped.pool_address=source.pool_address AND grouped.token_mint=source.token_mint
      WHERE source.episode_id=?
      ON CONFLICT(episode_id,horizon_minutes) DO NOTHING
    `).run(
      mark.horizonMinutes, mark.observedAt, mark.status, mark.targetRecoverySol,
      mark.doubleRecoverySol, mark.targetImpactBps, mark.doubleImpactBps, mark.detail, mark.episodeId
    );
  }

  listEpisodes(experimentId: string): ResearchEpisode[] {
    return (this.required().prepare('SELECT * FROM episodes WHERE experiment_id=? ORDER BY observed_at').all(experimentId) as Row[]).map(mapEpisode);
  }

  listMarks(experimentId: string): ResearchMark[] {
    return (this.required().prepare(`
      SELECT m.* FROM marks m JOIN episodes e ON e.episode_id=m.episode_id
      WHERE e.experiment_id=? ORDER BY e.observed_at,m.horizon_minutes
    `).all(experimentId) as Row[]).map((row) => ({
      episodeId: String(row.episode_id),
      horizonMinutes: Number(row.horizon_minutes) as ResearchMark['horizonMinutes'],
      observedAt: String(row.observed_at),
      status: String(row.status) as ResearchMark['status'],
      targetRecoverySol: nullableNumber(row.target_recovery_sol),
      doubleRecoverySol: nullableNumber(row.double_recovery_sol),
      targetImpactBps: nullableNumber(row.target_impact_bps),
      doubleImpactBps: nullableNumber(row.double_impact_bps),
      detail: String(row.detail ?? '')
    }));
  }

  syncPaperOutcomes(experimentId: string, outcomes: LiveCycleOutcomeRecord[]) {
    const experiment = this.required().prepare(`
      SELECT strategy_id AS strategyId,started_at AS startedAt FROM experiments WHERE experiment_id=?
    `).get(experimentId) as { strategyId: string; startedAt: string } | undefined;
    if (!experiment) throw new Error(`Unknown experiment ${experimentId}`);
    const insert = this.required().prepare(`
      INSERT OR REPLACE INTO paper_outcomes(
        outcome_id,experiment_id,strategy_id,recorded_at,opened_at,closed_at,runtime_mode,capture_mode,
        entry_sol,exit_value_sol,fee_value_sol,pnl_sol,raw_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const outcome of outcomes) {
      if (outcome.strategyId !== experiment.strategyId
        || outcome.captureMode !== 'mechanical-soak'
        || outcome.recordedAt < experiment.startedAt) {
        continue;
      }
      const exitValue = outcome.exitMetrics.lpTotalValueSol
        ?? outcome.exitMetrics.lpCurrentValueSol
        ?? outcome.exitMetrics.quoteOutputSol;
      const feeValue = outcome.exitMetrics.lpClaimedFeeValueSol ?? outcome.exitMetrics.lpUnclaimedFeeValueSol ?? 0;
      const pnl = typeof outcome.entrySol === 'number' && typeof exitValue === 'number'
        ? exitValue + feeValue - outcome.entrySol
        : null;
      insert.run(
        hashId('paper', outcome.strategyId, outcome.cycleId, outcome.recordedAt), experimentId, outcome.strategyId,
        outcome.recordedAt, outcome.openedAt ?? null, outcome.closedAt ?? null, outcome.runtimeMode, outcome.captureMode,
        outcome.entrySol ?? null, exitValue ?? null, feeValue, pnl, stableJson(outcome)
      );
    }
  }

  paperOutcomes(experimentId: string): Array<{ pnlSol: number; closedAt: string }> {
    return (this.required().prepare(`
      SELECT pnl_sol AS pnlSol,COALESCE(closed_at,recorded_at) AS closedAt
      FROM paper_outcomes WHERE experiment_id=? AND pnl_sol IS NOT NULL ORDER BY closedAt
    `).all(experimentId) as Array<{ pnlSol: number; closedAt: string }>);
  }

  saveReport(report: { reportId: string; experimentId: string; createdAt: string; status: string; [key: string]: unknown }) {
    this.required().prepare('INSERT OR REPLACE INTO reports(report_id,experiment_id,created_at,status,report_json) VALUES(?,?,?,?,?)')
      .run(report.reportId, report.experimentId, report.createdAt, report.status, stableJson(report));
  }

  recordWorkerStatus(input: { heartbeatAt: string; status: 'ok' | 'degraded'; due: number; completed: number; unavailable: number }) {
    this.required().prepare(`
      INSERT INTO worker_status(singleton,heartbeat_at,status,due_count,completed_count,unavailable_count)
      VALUES(1,?,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,status=excluded.status,
        due_count=excluded.due_count,completed_count=excluded.completed_count,unavailable_count=excluded.unavailable_count
    `).run(input.heartbeatAt, input.status, input.due, input.completed, input.unavailable);
  }

  status() {
    const database = this.required();
    const active = this.activeExperiment();
    const latest = this.latestExperiment();
    const displayed = active ?? latest?.spec ?? null;
    const experimentId = displayed?.experimentId ?? '';
    const scalar = (sql: string) => Number((database.prepare(sql).get(experimentId) as { count?: number } | undefined)?.count ?? 0);
    const marks = database.prepare(`
      SELECT m.horizon_minutes AS horizon,COUNT(*) AS count FROM marks m JOIN episodes e ON e.episode_id=m.episode_id
      WHERE e.experiment_id=? GROUP BY m.horizon_minutes
    `).all(experimentId) as Array<{ horizon: number; count: number }>;
    const worker = database.prepare('SELECT heartbeat_at AS heartbeatAt,status,due_count AS dueCount,completed_count AS completedCount,unavailable_count AS unavailableCount FROM worker_status WHERE singleton=1').get() ?? null;
    const summarizeExperiment = (spec: StrategyResearchSpec | null) => spec ? {
      experimentId: spec.experimentId,
      strategyId: spec.strategyId,
      variantIds: spec.variants.map((variant) => variant.variantId),
      thresholds: spec.thresholds
    } : null;
    return {
      activeExperiment: summarizeExperiment(active),
      latestExperiment: active ? null : summarizeExperiment(latest?.spec ?? null),
      experimentStatus: active ? 'active' : latest?.status ?? 'none',
      snapshotCount: scalar('SELECT COUNT(*) AS count FROM snapshots WHERE experiment_id=?'),
      episodeCount: scalar('SELECT COUNT(*) AS count FROM episodes WHERE experiment_id=?'),
      selectedEpisodeCount: scalar('SELECT COUNT(*) AS count FROM episodes WHERE experiment_id=? AND selected=1'),
      paperOutcomeCount: scalar('SELECT COUNT(*) AS count FROM paper_outcomes WHERE experiment_id=?'),
      marks: Object.fromEntries(marks.map((row) => [String(row.horizon), row.count])),
      worker
    };
  }

  exportRows(experimentId: string) {
    return this.required().prepare(`
      SELECT e.experiment_id,e.snapshot_id,e.variant_id,e.pool_address,e.token_mint,e.token_symbol,e.observed_at,
        e.position_sol,e.selected,m.horizon_minutes,m.status,m.target_recovery_sol,m.double_recovery_sol,
        m.target_impact_bps,m.double_impact_bps
      FROM episodes e LEFT JOIN marks m ON m.episode_id=e.episode_id
      WHERE e.experiment_id=? ORDER BY e.observed_at,e.variant_id,e.pool_address,m.horizon_minutes
    `).all(experimentId) as Row[];
  }

  checkpoint() {
    if (!this.readOnly) this.required().exec('PRAGMA wal_checkpoint(PASSIVE);');
  }

  private required() {
    if (!this.database) throw new Error(`Strategy research database is not open: ${this.path}`);
    return this.database;
  }
}

function mapEpisode(row: Row): ResearchEpisode {
  return {
    episodeId: String(row.episode_id), snapshotId: String(row.snapshot_id), experimentId: String(row.experiment_id),
    strategyId: String(row.strategy_id), variantId: String(row.variant_id), poolAddress: String(row.pool_address),
    tokenMint: String(row.token_mint), tokenSymbol: String(row.token_symbol), observedAt: String(row.observed_at),
    positionSol: Number(row.position_sol), selected: Boolean(row.selected),
    features: JSON.parse(String(row.features_json)) as Record<string, unknown>,
    entryStatus: row.entry_status === null || row.entry_status === undefined ? null : String(row.entry_status) as ResearchEpisode['entryStatus'],
    entryDetail: String(row.entry_detail ?? ''),
    targetTokenRaw: row.target_token_raw === null || row.target_token_raw === undefined ? null : String(row.target_token_raw),
    doubleTokenRaw: row.double_token_raw === null || row.double_token_raw === undefined ? null : String(row.double_token_raw)
  };
}

function nullableNumber(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

export function hashId(prefix: string, ...values: string[]) {
  return `${prefix}-${createHash('sha256').update(values.join('\0')).digest('hex').slice(0, 32)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
