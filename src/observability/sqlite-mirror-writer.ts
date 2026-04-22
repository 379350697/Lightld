import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  CandidateScanMirrorPayload,
  FillMirrorPayload,
  IncidentMirrorPayload,
  MirrorEvent,
  OrderMirrorPayload,
  ReconciliationMirrorPayload,
  RuntimeSnapshotMirrorPayload,
  WatchlistSnapshotMirrorPayload
} from './mirror-events.ts';
import { SQLITE_MIRROR_SCHEMA } from './sqlite-mirror-schema.ts';

type SqliteMirrorWriterOptions = {
  path: string;
  busyTimeoutMs?: number;
};

type PruneOptions = {
  retentionDays: number;
  now?: Date;
};

type PruneTableCounts = {
  cycleRuns: number;
  orders: number;
  fills: number;
  reconciliations: number;
  incidents: number;
  runtimeSnapshots: number;
  candidateScans: number;
  watchlistSnapshots: number;
};

export type MirrorPruneResult = {
  deletedRows: number;
  deletedByTable: PruneTableCounts;
};

type RecentIncidentRow = {
  incidentId: string;
  cycleId: string;
  stage: string;
  severity: 'warning' | 'error';
  reason: string;
  runtimeMode: string;
  recordedAt: string;
};

type RecentOrderRow = {
  idempotencyKey: string;
  submissionId: string;
  tokenSymbol: string;
  confirmationStatus: string;
  finality: string;
  updatedAt: string;
};

type RecentCandidateScanRow = {
  scanId: string;
  capturedAt: string;
  strategyId: string;
  selectedTokenMint: string;
  selectedPoolAddress: string;
  blockedReason: string;
  candidateCount: number;
};

type RecentWatchlistSnapshotRow = {
  watchId: string;
  trackedSince: string;
  strategyId: string;
  tokenMint: string;
  tokenSymbol: string;
  poolAddress: string;
  observationAt: string;
  windowLabel: string;
  currentValueSol: number | null;
  unclaimedFeeSol: number | null;
  hasInventory: boolean;
  hasLpPosition: boolean;
  sourceReason: string;
};

export class SqliteMirrorWriter {
  private readonly path: string;
  private readonly busyTimeoutMs: number;
  private database?: DatabaseSync;

  constructor(options: SqliteMirrorWriterOptions) {
    this.path = options.path;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 1000;
  }

  async open() {
    if (this.database) {
      return;
    }

    await mkdir(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);

    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${this.busyTimeoutMs};
    `);

    for (const statement of SQLITE_MIRROR_SCHEMA) {
      database.exec(statement);
    }

    this.ensureRuntimeSnapshotColumns(database);
    this.ensureOrderIdentityColumns(database);
    this.ensureFillIdentityColumns(database);

    this.database = database;
  }

  async close() {
    this.database?.close();
    this.database = undefined;
  }

  async writeBatch(events: MirrorEvent[]) {
    if (events.length === 0) {
      return;
    }

    const database = this.requireDatabase();
    database.exec('BEGIN IMMEDIATE');

    try {
      for (const event of events) {
        this.writeEvent(event);
      }
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // ignore rollback failures
      }
      throw error;
    }
  }

  async countRows(tableName: string) {
    const row = this.requireDatabase()
      .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
      .get() as { count: number };

    return row.count;
  }

  async readRecentIncidents(limit = 5): Promise<RecentIncidentRow[]> {
    return this.requireDatabase()
      .prepare(`
        SELECT
          incident_id AS incidentId,
          cycle_id AS cycleId,
          stage,
          severity,
          reason,
          runtime_mode AS runtimeMode,
          recorded_at AS recordedAt
        FROM incidents
        ORDER BY recorded_at DESC
        LIMIT ?
      `)
      .all(limit) as RecentIncidentRow[];
  }

  private ensureRuntimeSnapshotColumns(database: DatabaseSync) {
    const existingColumns = new Set((database.prepare('PRAGMA table_info(runtime_snapshots)').all() as Array<{ name: string }>)
      .map((column) => column.name));
    const requiredColumns = [
      ['wallet_sol', 'REAL'],
      ['lp_value_sol', 'REAL'],
      ['unclaimed_fee_sol', 'REAL'],
      ['net_worth_sol', 'REAL'],
      ['open_position_count', 'INTEGER']
    ] as const;

    for (const [columnName, columnType] of requiredColumns) {
      if (!existingColumns.has(columnName)) {
        database.exec(`ALTER TABLE runtime_snapshots ADD COLUMN ${columnName} ${columnType}`);
      }
    }
  }

  private ensureOrderIdentityColumns(database: DatabaseSync) {
    this.ensureTableColumns(database, 'orders', [
      ['open_intent_id', "TEXT NOT NULL DEFAULT ''"],
      ['position_id', "TEXT NOT NULL DEFAULT ''"],
      ['chain_position_address', "TEXT NOT NULL DEFAULT ''"]
    ]);
  }

  private ensureFillIdentityColumns(database: DatabaseSync) {
    this.ensureTableColumns(database, 'fills', [
      ['open_intent_id', "TEXT NOT NULL DEFAULT ''"],
      ['position_id', "TEXT NOT NULL DEFAULT ''"],
      ['chain_position_address', "TEXT NOT NULL DEFAULT ''"]
    ]);
  }

  private ensureTableColumns(database: DatabaseSync, tableName: string, columns: ReadonlyArray<readonly [string, string]>) {
    const existingColumns = new Set((database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
      .map((column) => column.name));

    for (const [columnName, columnType] of columns) {
      if (!existingColumns.has(columnName)) {
        database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
      }
    }
  }

  async readRecentOrders(limit = 5): Promise<RecentOrderRow[]> {
    return this.requireDatabase()
      .prepare(`
        SELECT
          idempotency_key AS idempotencyKey,
          submission_id AS submissionId,
          token_symbol AS tokenSymbol,
          confirmation_status AS confirmationStatus,
          finality,
          updated_at AS updatedAt
        FROM orders
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(limit) as RecentOrderRow[];
  }

  async readRecentCandidateScans(limit = 5): Promise<RecentCandidateScanRow[]> {
    return this.requireDatabase()
      .prepare(`
        SELECT
          scan_id AS scanId,
          captured_at AS capturedAt,
          strategy_id AS strategyId,
          selected_token_mint AS selectedTokenMint,
          selected_pool_address AS selectedPoolAddress,
          blocked_reason AS blockedReason,
          candidate_count AS candidateCount
        FROM candidate_scans
        ORDER BY captured_at DESC
        LIMIT ?
      `)
      .all(limit) as RecentCandidateScanRow[];
  }

  async readRecentWatchlistSnapshots(limit = 5): Promise<RecentWatchlistSnapshotRow[]> {
    return this.requireDatabase()
      .prepare(`
        SELECT
          watch_id AS watchId,
          tracked_since AS trackedSince,
          strategy_id AS strategyId,
          token_mint AS tokenMint,
          token_symbol AS tokenSymbol,
          pool_address AS poolAddress,
          observation_at AS observationAt,
          window_label AS windowLabel,
          current_value_sol AS currentValueSol,
          unclaimed_fee_sol AS unclaimedFeeSol,
          has_inventory AS hasInventory,
          has_lp_position AS hasLpPosition,
          source_reason AS sourceReason
        FROM watchlist_snapshots
        ORDER BY observation_at DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => ({
        ...row,
        hasInventory: Boolean(row.hasInventory),
        hasLpPosition: Boolean(row.hasLpPosition)
      })) as RecentWatchlistSnapshotRow[];
  }

  async checkpointWal(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE') {
    this.requireDatabase().exec(`PRAGMA wal_checkpoint(${mode});`);
  }

  async pruneOldData(options: PruneOptions): Promise<MirrorPruneResult> {
    const database = this.requireDatabase();
    const cutoffIso = new Date(
      (options.now ?? new Date()).getTime() - options.retentionDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const deletedByTable: PruneTableCounts = {
      cycleRuns: 0,
      orders: 0,
      fills: 0,
      reconciliations: 0,
      incidents: 0,
      runtimeSnapshots: 0,
      candidateScans: 0,
      watchlistSnapshots: 0
    };

    database.exec('BEGIN IMMEDIATE');

    try {
      deletedByTable.cycleRuns = this.deleteOlderThan('cycle_runs', 'finished_at', cutoffIso);
      deletedByTable.orders = this.deleteOlderThan('orders', 'updated_at', cutoffIso);
      deletedByTable.fills = this.deleteOlderThan('fills', 'recorded_at', cutoffIso);
      deletedByTable.reconciliations = this.deleteOlderThan('reconciliations', 'recorded_at', cutoffIso);
      deletedByTable.incidents = this.deleteOlderThan('incidents', 'recorded_at', cutoffIso);
      deletedByTable.runtimeSnapshots = this.deleteOlderThan('runtime_snapshots', 'snapshot_at', cutoffIso);
      deletedByTable.candidateScans = this.deleteOlderThan('candidate_scans', 'captured_at', cutoffIso);
      deletedByTable.watchlistSnapshots = this.deleteOlderThan('watchlist_snapshots', 'observation_at', cutoffIso);
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // ignore rollback failures
      }
      throw error;
    }

    await this.checkpointWal('TRUNCATE');

    return {
      deletedRows: Object.values(deletedByTable).reduce((sum, count) => sum + count, 0),
      deletedByTable
    };
  }

  private requireDatabase() {
    if (!this.database) {
      throw new Error('SQLite mirror database is not open');
    }

    return this.database;
  }

  private writeEvent(event: MirrorEvent) {
    switch (event.type) {
      case 'cycle_run':
        this.requireDatabase().prepare(`
          INSERT INTO cycle_runs (
            cycle_id,
            strategy_id,
            started_at,
            finished_at,
            runtime_mode,
            session_phase,
            action,
            result_mode,
            reason,
            pool_address,
            token_mint,
            token_symbol,
            requested_position_sol,
            quote_collected,
            live_order_submitted,
            confirmation_status,
            reconciliation_ok,
            duration_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(cycle_id) DO UPDATE SET
            finished_at=excluded.finished_at,
            runtime_mode=excluded.runtime_mode,
            session_phase=excluded.session_phase,
            action=excluded.action,
            result_mode=excluded.result_mode,
            reason=excluded.reason,
            pool_address=excluded.pool_address,
            token_mint=excluded.token_mint,
            token_symbol=excluded.token_symbol,
            requested_position_sol=excluded.requested_position_sol,
            quote_collected=excluded.quote_collected,
            live_order_submitted=excluded.live_order_submitted,
            confirmation_status=excluded.confirmation_status,
            reconciliation_ok=excluded.reconciliation_ok,
            duration_ms=excluded.duration_ms
        `).run(
          event.payload.cycleId,
          event.payload.strategyId,
          event.payload.startedAt,
          event.payload.finishedAt,
          event.payload.runtimeMode,
          event.payload.sessionPhase,
          event.payload.action,
          event.payload.resultMode,
          event.payload.reason,
          event.payload.poolAddress,
          event.payload.tokenMint,
          event.payload.tokenSymbol,
          event.payload.requestedPositionSol,
          booleanToInteger(event.payload.quoteCollected),
          booleanToInteger(event.payload.liveOrderSubmitted),
          event.payload.confirmationStatus,
          booleanToInteger(event.payload.reconciliationOk),
          event.payload.durationMs
        );
        return;

      case 'order':
        this.writeOrder(event.payload);
        return;

      case 'fill':
        this.writeFill(event.payload);
        return;

      case 'reconciliation':
        this.writeReconciliation(event.payload);
        return;

      case 'incident':
        this.writeIncident(event.payload);
        return;

      case 'runtime_snapshot':
        this.writeRuntimeSnapshot(event.payload);
        return;

      case 'candidate_scan':
        this.writeCandidateScan(event.payload);
        return;

      case 'watchlist_snapshot':
        this.writeWatchlistSnapshot(event.payload);
        return;
    }
  }

  private writeOrder(payload: OrderMirrorPayload) {
    this.requireDatabase().prepare(`
      INSERT INTO orders (
        idempotency_key,
        cycle_id,
        strategy_id,
        submission_id,
        open_intent_id,
        position_id,
        chain_position_address,
        confirmation_signature,
        pool_address,
        token_mint,
        token_symbol,
        action,
        requested_position_sol,
        quoted_output_sol,
        broadcast_status,
        confirmation_status,
        finality,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        cycle_id=excluded.cycle_id,
        strategy_id=excluded.strategy_id,
        submission_id=excluded.submission_id,
        open_intent_id=excluded.open_intent_id,
        position_id=excluded.position_id,
        chain_position_address=excluded.chain_position_address,
        confirmation_signature=excluded.confirmation_signature,
        pool_address=excluded.pool_address,
        token_mint=excluded.token_mint,
        token_symbol=excluded.token_symbol,
        action=excluded.action,
        requested_position_sol=excluded.requested_position_sol,
        quoted_output_sol=excluded.quoted_output_sol,
        broadcast_status=excluded.broadcast_status,
        confirmation_status=excluded.confirmation_status,
        finality=excluded.finality,
        updated_at=excluded.updated_at
    `).run(
      payload.idempotencyKey,
      payload.cycleId,
      payload.strategyId,
      payload.submissionId,
      payload.openIntentId ?? '',
      payload.positionId ?? '',
      payload.chainPositionAddress ?? '',
      payload.confirmationSignature,
      payload.poolAddress,
      payload.tokenMint,
      payload.tokenSymbol,
      payload.action,
      payload.requestedPositionSol,
      payload.quotedOutputSol,
      payload.broadcastStatus,
      payload.confirmationStatus,
      payload.finality,
      payload.createdAt,
      payload.updatedAt
    );
  }

  private writeFill(payload: FillMirrorPayload) {
    this.requireDatabase().prepare(`
      INSERT INTO fills (
        fill_id,
        submission_id,
        open_intent_id,
        position_id,
        chain_position_address,
        confirmation_signature,
        cycle_id,
        token_mint,
        token_symbol,
        side,
        amount,
        filled_sol,
        recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fill_id) DO NOTHING
    `).run(
      payload.fillId,
      payload.submissionId,
      payload.openIntentId ?? '',
      payload.positionId ?? '',
      payload.chainPositionAddress ?? '',
      payload.confirmationSignature,
      payload.cycleId,
      payload.tokenMint,
      payload.tokenSymbol,
      payload.side,
      payload.amount,
      payload.filledSol,
      payload.recordedAt
    );
  }

  private writeReconciliation(payload: ReconciliationMirrorPayload) {
    this.requireDatabase().prepare(`
      INSERT INTO reconciliations (
        cycle_id,
        wallet_sol,
        journal_sol,
        delta_sol,
        token_delta_count,
        ok,
        reason,
        recorded_at,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cycle_id) DO UPDATE SET
        wallet_sol=excluded.wallet_sol,
        journal_sol=excluded.journal_sol,
        delta_sol=excluded.delta_sol,
        token_delta_count=excluded.token_delta_count,
        ok=excluded.ok,
        reason=excluded.reason,
        recorded_at=excluded.recorded_at,
        raw_json=excluded.raw_json
    `).run(
      payload.cycleId,
      payload.walletSol,
      payload.journalSol,
      payload.deltaSol,
      payload.tokenDeltaCount,
      booleanToInteger(payload.ok),
      payload.reason,
      payload.recordedAt,
      payload.rawJson
    );
  }

  private writeIncident(payload: IncidentMirrorPayload) {
    this.requireDatabase().prepare(`
      INSERT INTO incidents (
        incident_id,
        cycle_id,
        stage,
        severity,
        reason,
        runtime_mode,
        submission_id,
        token_mint,
        token_symbol,
        recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(incident_id) DO NOTHING
    `).run(
      payload.incidentId,
      payload.cycleId,
      payload.stage,
      payload.severity,
      payload.reason,
      payload.runtimeMode,
      payload.submissionId,
      payload.tokenMint,
      payload.tokenSymbol,
      payload.recordedAt
    );
  }

  private writeRuntimeSnapshot(payload: RuntimeSnapshotMirrorPayload) {
    this.requireDatabase().prepare(`
      INSERT INTO runtime_snapshots (
        snapshot_at,
        runtime_mode,
        allow_new_opens,
        flatten_only,
        pending_submission,
        circuit_reason,
        quote_failures,
        reconcile_failures,
        wallet_sol,
        lp_value_sol,
        unclaimed_fee_sol,
        net_worth_sol,
        open_position_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_at) DO UPDATE SET
        runtime_mode=excluded.runtime_mode,
        allow_new_opens=excluded.allow_new_opens,
        flatten_only=excluded.flatten_only,
        pending_submission=excluded.pending_submission,
        circuit_reason=excluded.circuit_reason,
        quote_failures=excluded.quote_failures,
        reconcile_failures=excluded.reconcile_failures,
        wallet_sol=excluded.wallet_sol,
        lp_value_sol=excluded.lp_value_sol,
        unclaimed_fee_sol=excluded.unclaimed_fee_sol,
        net_worth_sol=excluded.net_worth_sol,
        open_position_count=excluded.open_position_count
    `).run(
      payload.snapshotAt,
      payload.runtimeMode,
      booleanToInteger(payload.allowNewOpens),
      booleanToInteger(payload.flattenOnly),
      booleanToInteger(payload.pendingSubmission),
      payload.circuitReason,
      payload.quoteFailures,
      payload.reconcileFailures,
      payload.walletSol,
      payload.lpValueSol,
      payload.unclaimedFeeSol,
      payload.netWorthSol,
      payload.openPositionCount
    );
  }

  private writeCandidateScan(payload: CandidateScanMirrorPayload) {
    this.requireDatabase().prepare(`
      INSERT INTO candidate_scans (
        scan_id,
        captured_at,
        strategy_id,
        pool_count,
        prefiltered_count,
        post_lp_count,
        post_safety_count,
        eligible_selection_count,
        scan_window_open,
        active_positions_count,
        selected_token_mint,
        selected_pool_address,
        blocked_reason,
        candidate_count,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scan_id) DO UPDATE SET
        captured_at=excluded.captured_at,
        strategy_id=excluded.strategy_id,
        pool_count=excluded.pool_count,
        prefiltered_count=excluded.prefiltered_count,
        post_lp_count=excluded.post_lp_count,
        post_safety_count=excluded.post_safety_count,
        eligible_selection_count=excluded.eligible_selection_count,
        scan_window_open=excluded.scan_window_open,
        active_positions_count=excluded.active_positions_count,
        selected_token_mint=excluded.selected_token_mint,
        selected_pool_address=excluded.selected_pool_address,
        blocked_reason=excluded.blocked_reason,
        candidate_count=excluded.candidate_count,
        raw_json=excluded.raw_json
    `).run(
      payload.scanId,
      payload.capturedAt,
      payload.strategyId,
      payload.poolCount,
      payload.prefilteredCount,
      payload.postLpCount,
      payload.postSafetyCount,
      payload.eligibleSelectionCount,
      booleanToInteger(payload.scanWindowOpen),
      payload.activePositionsCount,
      payload.selectedTokenMint,
      payload.selectedPoolAddress,
      payload.blockedReason,
      payload.candidates.length,
      JSON.stringify(payload)
    );
  }

  private writeWatchlistSnapshot(payload: WatchlistSnapshotMirrorPayload) {
    this.requireDatabase().prepare(`
      INSERT INTO watchlist_snapshots (
        watch_id,
        tracked_since,
        strategy_id,
        token_mint,
        token_symbol,
        pool_address,
        observation_at,
        window_label,
        current_value_sol,
        liquidity_usd,
        active_bin_id,
        lower_bin_id,
        upper_bin_id,
        bin_count,
        funded_bin_count,
        sol_depleted_bins,
        unclaimed_fee_sol,
        has_inventory,
        has_lp_position,
        source_reason,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(watch_id, tracked_since, window_label) DO UPDATE SET
        strategy_id=excluded.strategy_id,
        token_mint=excluded.token_mint,
        token_symbol=excluded.token_symbol,
        pool_address=excluded.pool_address,
        observation_at=excluded.observation_at,
        current_value_sol=excluded.current_value_sol,
        liquidity_usd=excluded.liquidity_usd,
        active_bin_id=excluded.active_bin_id,
        lower_bin_id=excluded.lower_bin_id,
        upper_bin_id=excluded.upper_bin_id,
        bin_count=excluded.bin_count,
        funded_bin_count=excluded.funded_bin_count,
        sol_depleted_bins=excluded.sol_depleted_bins,
        unclaimed_fee_sol=excluded.unclaimed_fee_sol,
        has_inventory=excluded.has_inventory,
        has_lp_position=excluded.has_lp_position,
        source_reason=excluded.source_reason,
        raw_json=excluded.raw_json
    `).run(
      payload.watchId,
      payload.trackedSince,
      payload.strategyId,
      payload.tokenMint,
      payload.tokenSymbol,
      payload.poolAddress,
      payload.observationAt,
      payload.windowLabel,
      payload.currentValueSol,
      payload.liquidityUsd,
      payload.activeBinId,
      payload.lowerBinId,
      payload.upperBinId,
      payload.binCount,
      payload.fundedBinCount,
      payload.solDepletedBins,
      payload.unclaimedFeeSol,
      booleanToInteger(payload.hasInventory),
      booleanToInteger(payload.hasLpPosition),
      payload.sourceReason,
      JSON.stringify(payload)
    );
  }

  private deleteOlderThan(tableName: string, columnName: string, cutoffIso: string) {
    const result = this.requireDatabase()
      .prepare(`DELETE FROM ${tableName} WHERE ${columnName} < ?`)
      .run(cutoffIso) as { changes?: number };

    return result.changes ?? 0;
  }
}

function booleanToInteger(value: boolean) {
  return value ? 1 : 0;
}
