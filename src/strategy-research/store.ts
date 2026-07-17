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
import {
  RESEARCH_ENTRY_MAX_DELAY_MINUTES,
  RESEARCH_HORIZONS,
  RESEARCH_HORIZON_TOLERANCE_MINUTES
} from './types.ts';

const HORIZONS = RESEARCH_HORIZONS;

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
    selection_id TEXT,
    snapshot_id TEXT,
    variant_id TEXT,
    entry_sol REAL,
    exit_value_sol REAL,
    fee_value_sol REAL,
    pnl_sol REAL,
    valuation_trust TEXT,
    valuation_completeness TEXT,
    pnl_evidence_kind TEXT NOT NULL DEFAULT 'legacy-untrusted',
    raw_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS paper_selections (
    selection_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    selected_at TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_paper_selections_match
    ON paper_selections(experiment_id,pool_address,token_mint,selected_at);
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
    unavailable_count INTEGER NOT NULL,
    missed_count INTEGER NOT NULL DEFAULT 0
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
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.path, this.readOnly ? { readOnly: true } : {});
      database.exec('PRAGMA busy_timeout=2000; PRAGMA temp_store=MEMORY;');
      if (!this.readOnly) {
        database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
        database.exec(SCHEMA);
        ensureColumn(database, 'paper_outcomes', 'capture_mode', "TEXT NOT NULL DEFAULT 'unknown'");
        ensureColumn(database, 'paper_outcomes', 'selection_id', 'TEXT');
        ensureColumn(database, 'paper_outcomes', 'snapshot_id', 'TEXT');
        ensureColumn(database, 'paper_outcomes', 'variant_id', 'TEXT');
        ensureColumn(database, 'paper_outcomes', 'valuation_trust', 'TEXT');
        ensureColumn(database, 'paper_outcomes', 'valuation_completeness', 'TEXT');
        ensureColumn(database, 'paper_outcomes', 'pnl_evidence_kind', "TEXT NOT NULL DEFAULT 'legacy-untrusted'");
        // Older rows were allowed to derive PnL from display/fallback values,
        // and their raw outcome did not retain enough trust metadata to
        // repair them safely. Fail closed instead of carrying that pollution
        // into a new analysis.
        database.prepare(`
          UPDATE paper_outcomes SET exit_value_sol=NULL,pnl_sol=NULL
          WHERE pnl_evidence_kind='legacy-untrusted'
        `).run();
        ensureColumn(database, 'paper_selections', 'variant_id', "TEXT NOT NULL DEFAULT 'baseline'");
        ensureColumn(database, 'worker_status', 'missed_count', 'INTEGER NOT NULL DEFAULT 0');
      }
      this.database = database;
    } catch (error) {
      database?.close();
      throw error;
    }
  }

  async openBestEffort(logger: Pick<Console, 'warn'> = console) {
    try {
      await this.open();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Strategy research disabled because its database could not be opened: ${message}`);
      this.close();
      return false;
    }
  }

  close() {
    this.database?.close();
    this.database = undefined;
  }

  startExperiment(spec: StrategyResearchSpec, startedAt = new Date().toISOString()) {
    if (!spec.baseConfig) throw new Error('Strategy research experiment must lock its baseline config before start');
    if (!Number.isFinite(Date.parse(startedAt))) throw new Error(`Invalid experiment start time: ${startedAt}`);
    const database = this.required();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare("UPDATE experiments SET status='stopped', stopped_at=? WHERE status='active' AND experiment_id<>?")
        .run(startedAt, spec.experimentId);
      const existing = database.prepare('SELECT spec_json AS specJson,status FROM experiments WHERE experiment_id=?')
        .get(spec.experimentId) as { specJson?: string; status?: string } | undefined;
      if (existing?.specJson && stableJson(JSON.parse(existing.specJson)) !== stableJson(spec)) {
        throw new Error(`Experiment ${spec.experimentId} already exists with a different spec`);
      }
      if (existing?.status === 'stopped') {
        throw new Error(`Experiment ${spec.experimentId} is stopped; start a new experiment ID instead`);
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
      const experiment = database.prepare(`
        SELECT strategy_id AS strategyId,status FROM experiments WHERE experiment_id=?
      `).get(input.experimentId) as { strategyId: string; status: string } | undefined;
      if (!experiment) throw new Error(`Unknown experiment ${input.experimentId}`);
      if (experiment.status !== 'active') throw new Error(`Experiment ${input.experimentId} is not active`);
      if (experiment.strategyId !== input.strategyId) {
        throw new Error(`Research snapshot strategy does not match experiment ${input.experimentId}`);
      }
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
      const readDecision = database.prepare(`
        SELECT selected,eligible,reason,position_sol AS positionSol FROM decisions
        WHERE snapshot_id=? AND variant_id=? AND pool_address=? AND token_mint=?
      `);
      const insertEpisode = database.prepare(`
        INSERT OR IGNORE INTO episodes(
          episode_id,snapshot_id,experiment_id,strategy_id,variant_id,pool_address,token_mint,token_symbol,
          observed_at,position_sol,selected,features_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const decision of input.decisions) {
        const candidate = byCandidate.get(`${decision.poolAddress}\0${decision.tokenMint}`);
        if (!candidate) throw new Error('Research decision references a missing candidate');
        insertDecision.run(
          input.snapshotId, decision.variantId, decision.poolAddress, decision.tokenMint,
          Number(decision.selected), Number(decision.eligible), decision.reason, decision.positionSol
        );
        const storedDecision = readDecision.get(
          input.snapshotId, decision.variantId, decision.poolAddress, decision.tokenMint
        ) as { selected: number; eligible: number; reason: string; positionSol: number };
        if (storedDecision.selected !== Number(decision.selected)
          || storedDecision.eligible !== Number(decision.eligible)
          || storedDecision.reason !== decision.reason
          || storedDecision.positionSol !== decision.positionSol) {
          throw new Error(`Conflicting research decision for snapshot ${input.snapshotId}`);
        }
        if (!decision.selected) continue;
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

  dueEpisodes(now = new Date(), limit = 100): Array<{ episode: ResearchEpisode; horizonMinutes: 0 | ResearchMark['horizonMinutes']; missed: boolean }> {
    const rows = this.required().prepare(`
      SELECT e.*, GROUP_CONCAT(CASE WHEN m.status<>'unavailable' THEN m.horizon_minutes END) AS completed_horizons
      FROM episodes e
      JOIN experiments x ON x.experiment_id=e.experiment_id AND x.status='active'
      LEFT JOIN marks m ON m.episode_id=e.episode_id
      GROUP BY e.episode_id ORDER BY e.observed_at ASC
    `).all() as Row[];
    const due: Array<{ episode: ResearchEpisode; horizonMinutes: 0 | ResearchMark['horizonMinutes']; missed: boolean }> = [];
    const scheduled = new Set<string>();
    for (const row of rows) {
      const episode = mapEpisode(row);
      const ageMinutes = (now.getTime() - Date.parse(episode.observedAt)) / 60_000;
      if (!Number.isFinite(ageMinutes) || ageMinutes < 0) continue;
      const entryStatus = row.entry_status === null || row.entry_status === undefined ? '' : String(row.entry_status);
      if ((!episode.targetTokenRaw || !episode.doubleTokenRaw) && (entryStatus === '' || entryStatus === 'unavailable')) {
        const key = `${episode.episodeId}:0`;
        if (!scheduled.has(key)) {
          scheduled.add(key);
          due.push({ episode, horizonMinutes: 0, missed: ageMinutes > RESEARCH_ENTRY_MAX_DELAY_MINUTES });
        }
      } else if (episode.targetTokenRaw && episode.doubleTokenRaw) {
        const completed = new Set(String(row.completed_horizons ?? '').split(',').filter(Boolean).map(Number));
        const horizon = HORIZONS.find((value) => ageMinutes >= value && !completed.has(value));
        if (horizon) {
          const key = `${episode.episodeId}:${horizon}`;
          if (!scheduled.has(key)) {
            scheduled.add(key);
            due.push({
              episode,
              horizonMinutes: horizon,
              missed: ageMinutes > horizon + RESEARCH_HORIZON_TOLERANCE_MINUTES[horizon]
            });
          }
        }
      }
    }
    return due.sort((left, right) => {
      if (left.missed !== right.missed) return left.missed ? 1 : -1;
      const leftTolerance = left.horizonMinutes === 0
        ? RESEARCH_ENTRY_MAX_DELAY_MINUTES
        : RESEARCH_HORIZON_TOLERANCE_MINUTES[left.horizonMinutes];
      const rightTolerance = right.horizonMinutes === 0
        ? RESEARCH_ENTRY_MAX_DELAY_MINUTES
        : RESEARCH_HORIZON_TOLERANCE_MINUTES[right.horizonMinutes];
      const leftDeadline = Date.parse(left.episode.observedAt) + (left.horizonMinutes + leftTolerance) * 60_000;
      const rightDeadline = Date.parse(right.episode.observedAt) + (right.horizonMinutes + rightTolerance) * 60_000;
      return leftDeadline - rightDeadline;
    }).slice(0, limit);
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
      WHERE episode_id=?
        AND EXISTS (
          SELECT 1 FROM episodes source JOIN experiments x ON x.experiment_id=source.experiment_id
          WHERE source.episode_id=? AND x.status='active'
        )
    `).run(
      input.targetTokenRaw ?? null, input.doubleTokenRaw ?? null, input.targetImpactBps ?? null,
      input.doubleImpactBps ?? null, input.status, input.detail ?? '', input.episodeId, input.episodeId
    );
  }

  recordMark(mark: ResearchMark) {
    this.required().prepare(`
      INSERT INTO marks(episode_id,horizon_minutes,observed_at,status,target_recovery_sol,double_recovery_sol,target_impact_bps,double_impact_bps,detail)
      SELECT source.episode_id,?,?,?,?,?,?,?,?
      FROM episodes source
      JOIN experiments x ON x.experiment_id=source.experiment_id AND x.status='active'
      WHERE source.episode_id=?
      ON CONFLICT(episode_id,horizon_minutes) DO UPDATE SET
        observed_at=excluded.observed_at,status=excluded.status,target_recovery_sol=excluded.target_recovery_sol,
        double_recovery_sol=excluded.double_recovery_sol,target_impact_bps=excluded.target_impact_bps,
        double_impact_bps=excluded.double_impact_bps,detail=excluded.detail
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

  snapshotTimes(experimentId: string): string[] {
    return (this.required().prepare(`
      SELECT observed_at AS observedAt FROM snapshots WHERE experiment_id=? ORDER BY observed_at
    `).all(experimentId) as Array<{ observedAt: string }>).map((row) => row.observedAt);
  }

  snapshotPolicyActions(experimentId: string): Array<{
    snapshotId: string;
    observedAt: string;
    variantId: string;
    selected: boolean;
  }> {
    return (this.required().prepare(`
      SELECT s.snapshot_id AS snapshotId,s.observed_at AS observedAt,d.variant_id AS variantId,
        MAX(d.selected) AS selected
      FROM snapshots s
      JOIN decisions d ON d.snapshot_id=s.snapshot_id
      WHERE s.experiment_id=?
      GROUP BY s.snapshot_id,s.observed_at,d.variant_id
      ORDER BY s.observed_at,d.variant_id
    `).all(experimentId) as Array<{
      snapshotId: string;
      observedAt: string;
      variantId: string;
      selected: number;
    }>).map((row) => ({ ...row, selected: Boolean(row.selected) }));
  }

  recordPaperSelection(input: {
    strategyId: string;
    poolAddress: string;
    tokenMint: string;
    selectedAt: string;
    action: string;
    reason: string;
  }) {
    const selectedAtMs = Date.parse(input.selectedAt);
    if (!Number.isFinite(selectedAtMs)) throw new Error(`Invalid paper selection time: ${input.selectedAt}`);
    const snapshotCutoff = new Date(selectedAtMs - 30 * 60_000).toISOString();
    const match = this.required().prepare(`
      SELECT x.experiment_id AS experimentId,s.snapshot_id AS snapshotId,d.variant_id AS variantId
      FROM experiments x
      JOIN snapshots s ON s.experiment_id=x.experiment_id
      JOIN decisions d ON d.snapshot_id=s.snapshot_id AND d.pool_address=? AND d.token_mint=?
      WHERE x.status='active' AND x.strategy_id=? AND d.variant_id='baseline' AND d.selected=1
        AND s.observed_at>=? AND s.observed_at<=?
      ORDER BY s.observed_at DESC
      LIMIT 1
    `).get(input.poolAddress, input.tokenMint, input.strategyId, snapshotCutoff, input.selectedAt) as {
      experimentId: string;
      snapshotId: string;
      variantId: string;
    } | undefined;
    if (!match) return null;
    const selectionId = hashId('paper-selection', match.experimentId, match.snapshotId, input.poolAddress, input.tokenMint);
    this.required().prepare(`
      INSERT OR IGNORE INTO paper_selections(
        selection_id,experiment_id,snapshot_id,variant_id,strategy_id,pool_address,token_mint,selected_at,action,reason
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      selectionId, match.experimentId, match.snapshotId, match.variantId, input.strategyId, input.poolAddress,
      input.tokenMint, input.selectedAt, input.action, input.reason
    );
    return { selectionId, ...match };
  }

  syncPaperOutcomes(experimentId: string, outcomes: LiveCycleOutcomeRecord[]) {
    const experiment = this.required().prepare(`
      SELECT strategy_id AS strategyId,started_at AS startedAt,stopped_at AS stoppedAt FROM experiments WHERE experiment_id=?
    `).get(experimentId) as { strategyId: string; startedAt: string; stoppedAt: string | null } | undefined;
    if (!experiment) throw new Error(`Unknown experiment ${experimentId}`);
    const insert = this.required().prepare(`
      INSERT OR REPLACE INTO paper_outcomes(
        outcome_id,experiment_id,strategy_id,recorded_at,opened_at,closed_at,runtime_mode,capture_mode,selection_id,snapshot_id,variant_id,
        entry_sol,exit_value_sol,fee_value_sol,pnl_sol,valuation_trust,valuation_completeness,pnl_evidence_kind,raw_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const outcome of outcomes) {
      if (outcome.strategyId !== experiment.strategyId
        || outcome.captureMode !== 'mechanical-soak') {
        continue;
      }
      const selectionTime = outcome.openedAt ?? outcome.recordedAt;
      if (selectionTime < experiment.startedAt
        || (experiment.stoppedAt !== null && selectionTime > experiment.stoppedAt)) {
        continue;
      }
      const selectionTimeMs = Date.parse(selectionTime);
      const selectionCutoff = Number.isFinite(selectionTimeMs)
        ? new Date(selectionTimeMs - 30 * 60_000).toISOString()
        : '';
      const selection = selectionCutoff ? this.required().prepare(`
          SELECT selection_id AS selectionId,snapshot_id AS snapshotId,variant_id AS variantId
          FROM paper_selections
          WHERE experiment_id=? AND pool_address=? AND token_mint=? AND selected_at>=? AND selected_at<=?
          ORDER BY selected_at DESC LIMIT 1
        `).get(experimentId, outcome.poolAddress, outcome.tokenMint, selectionCutoff, selectionTime) as {
          selectionId: string;
          snapshotId: string;
          variantId: string;
        } | undefined : undefined;
      const syntheticLpLifecycle = outcome.action === 'withdraw-lp';
      const executableSpotQuote = outcome.action === 'dca-out'
        && outcome.exitMetrics.settlementEvidence === 'paper-executable-spot-quote';
      const completeExitQuote = !syntheticLpLifecycle
        && outcome.exitMetrics.valuationTrust === 'exit_quote'
        && outcome.exitMetrics.valuationCompleteness === 'complete';
      const pnlEvidenceKind = executableSpotQuote
        ? 'paper-executable-spot-quote'
        : completeExitQuote
          ? 'complete-exit-quote'
          : 'lifecycle-only';
      const hasPnlEvidence = pnlEvidenceKind !== 'lifecycle-only';
      const hasTradingValuePair = completeExitQuote
        && typeof outcome.exitMetrics.lpTradingValueSol === 'number'
        && typeof outcome.exitMetrics.lpEntryTradingSol === 'number';
      const entryValue = hasTradingValuePair
        ? outcome.exitMetrics.lpEntryTradingSol
        : outcome.entrySol;
      const exitValue = !hasPnlEvidence
        ? undefined
        : executableSpotQuote
          ? outcome.exitMetrics.quoteOutputSol
          : hasTradingValuePair
            ? outcome.exitMetrics.lpTradingValueSol
            : outcome.exitMetrics.exitQuoteValueSol
            ?? outcome.exitMetrics.lpTotalValueSol
            ?? outcome.exitMetrics.lpCurrentValueSol
            ?? outcome.exitMetrics.quoteOutputSol;
      const feeValue = (outcome.exitMetrics.lpClaimedFeeValueSol ?? 0)
        + (outcome.exitMetrics.lpUnclaimedFeeValueSol ?? 0);
      // LP total/trading valuation already includes claimed and unclaimed fees.
      // Adding feeValue again here would overstate every trusted exit estimate.
      const pnl = typeof entryValue === 'number' && typeof exitValue === 'number'
        ? exitValue - entryValue
        : null;
      insert.run(
        hashId('paper', experimentId, outcome.strategyId, outcome.cycleId, outcome.recordedAt), experimentId, outcome.strategyId,
        outcome.recordedAt, outcome.openedAt ?? null, outcome.closedAt ?? null, outcome.runtimeMode, outcome.captureMode,
        selection?.selectionId ?? null, selection?.snapshotId ?? null, selection?.variantId ?? null,
        entryValue ?? null, exitValue ?? null, feeValue, pnl,
        outcome.exitMetrics.valuationTrust ?? null,
        outcome.exitMetrics.valuationCompleteness ?? null,
        pnlEvidenceKind,
        stableJson(outcome)
      );
    }
  }

  paperOutcomes(experimentId: string): Array<{
    pnlSol: number | null;
    closedAt: string;
    selectionId: string | null;
    snapshotId: string | null;
    variantId: string | null;
    pnlEvidenceKind: string;
  }> {
    const hasPnlEvidenceKind = tableHasColumn(this.required(), 'paper_outcomes', 'pnl_evidence_kind');
    return (this.required().prepare(hasPnlEvidenceKind ? `
      SELECT pnl_sol AS pnlSol,COALESCE(closed_at,recorded_at) AS closedAt,
        selection_id AS selectionId,snapshot_id AS snapshotId,variant_id AS variantId,
        pnl_evidence_kind AS pnlEvidenceKind
      FROM paper_outcomes WHERE experiment_id=? ORDER BY closedAt
    ` : `
      SELECT NULL AS pnlSol,COALESCE(closed_at,recorded_at) AS closedAt,
        selection_id AS selectionId,snapshot_id AS snapshotId,variant_id AS variantId,
        'legacy-untrusted' AS pnlEvidenceKind
      FROM paper_outcomes WHERE experiment_id=? ORDER BY closedAt
    `).all(experimentId) as Array<{
      pnlSol: number | null;
      closedAt: string;
      selectionId: string | null;
      snapshotId: string | null;
      variantId: string | null;
      pnlEvidenceKind: string;
    }>);
  }

  saveReport(report: { reportId: string; experimentId: string; createdAt: string; status: string; [key: string]: unknown }) {
    this.required().prepare('INSERT OR REPLACE INTO reports(report_id,experiment_id,created_at,status,report_json) VALUES(?,?,?,?,?)')
      .run(report.reportId, report.experimentId, report.createdAt, report.status, stableJson(report));
  }

  recordWorkerStatus(input: { heartbeatAt: string; status: 'ok' | 'degraded'; due: number; completed: number; unavailable: number; missed?: number }) {
    this.required().prepare(`
      INSERT INTO worker_status(singleton,heartbeat_at,status,due_count,completed_count,unavailable_count,missed_count)
      VALUES(1,?,?,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,status=excluded.status,
        due_count=excluded.due_count,completed_count=excluded.completed_count,unavailable_count=excluded.unavailable_count,
        missed_count=excluded.missed_count
    `).run(input.heartbeatAt, input.status, input.due, input.completed, input.unavailable, input.missed ?? 0);
  }

  status() {
    const database = this.required();
    const active = this.activeExperiment();
    const latest = this.latestExperiment();
    const displayed = active ?? latest?.spec ?? null;
    const experimentId = displayed?.experimentId ?? '';
    const scalar = (sql: string) => Number((database.prepare(sql).get(experimentId) as { count?: number } | undefined)?.count ?? 0);
    const marks = database.prepare(`
      SELECT m.horizon_minutes AS horizon,
        SUM(CASE WHEN m.status NOT IN ('unavailable','missed') THEN 1 ELSE 0 END) AS count,
        SUM(CASE WHEN m.status='unavailable' THEN 1 ELSE 0 END) AS unavailable,
        SUM(CASE WHEN m.status='missed' THEN 1 ELSE 0 END) AS missed
      FROM marks m JOIN episodes e ON e.episode_id=m.episode_id
      WHERE e.experiment_id=? GROUP BY m.horizon_minutes
    `).all(experimentId) as Array<{ horizon: number; count: number; unavailable: number; missed: number }>;
    const worker = database.prepare('SELECT heartbeat_at AS heartbeatAt,status,due_count AS dueCount,completed_count AS completedCount,unavailable_count AS unavailableCount,missed_count AS missedCount FROM worker_status WHERE singleton=1').get() ?? null;
    const summarizeExperiment = (spec: StrategyResearchSpec | null) => spec ? {
      experimentId: spec.experimentId,
      strategyId: spec.strategyId,
      variantIds: spec.variants.map((variant) => variant.variantId),
      thresholds: spec.thresholds
    } : null;
    const hasPnlEvidenceKind = tableHasColumn(database, 'paper_outcomes', 'pnl_evidence_kind');
    return {
      activeExperiment: summarizeExperiment(active),
      latestExperiment: active ? null : summarizeExperiment(latest?.spec ?? null),
      experimentStatus: active ? 'active' : latest?.status ?? 'none',
      snapshotCount: scalar('SELECT COUNT(*) AS count FROM snapshots WHERE experiment_id=?'),
      episodeCount: scalar('SELECT COUNT(*) AS count FROM episodes WHERE experiment_id=?'),
      selectedEpisodeCount: scalar('SELECT COUNT(*) AS count FROM episodes WHERE experiment_id=? AND selected=1'),
      paperOutcomeCount: scalar('SELECT COUNT(*) AS count FROM paper_outcomes WHERE experiment_id=?'),
      boundPaperOutcomeCount: scalar('SELECT COUNT(*) AS count FROM paper_outcomes WHERE experiment_id=? AND selection_id IS NOT NULL'),
      paperExecutablePnlCount: hasPnlEvidenceKind
        ? scalar("SELECT COUNT(*) AS count FROM paper_outcomes WHERE experiment_id=? AND pnl_sol IS NOT NULL AND pnl_evidence_kind NOT IN ('legacy-untrusted','lifecycle-only')")
        : 0,
      boundPaperExecutablePnlCount: hasPnlEvidenceKind
        ? scalar("SELECT COUNT(*) AS count FROM paper_outcomes WHERE experiment_id=? AND selection_id IS NOT NULL AND pnl_sol IS NOT NULL AND pnl_evidence_kind NOT IN ('legacy-untrusted','lifecycle-only')")
        : 0,
      marks: Object.fromEntries(marks.map((row) => [String(row.horizon), row.count])),
      markFailures: Object.fromEntries(marks.map((row) => [String(row.horizon), { unavailable: row.unavailable, missed: row.missed }])),
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
    doubleTokenRaw: row.double_token_raw === null || row.double_token_raw === undefined ? null : String(row.double_token_raw),
    entryTargetImpactBps: nullableNumber(row.entry_target_impact_bps),
    entryDoubleImpactBps: nullableNumber(row.entry_double_impact_bps)
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
  if (!tableHasColumn(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableHasColumn(database: DatabaseSync, table: string, column: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}
