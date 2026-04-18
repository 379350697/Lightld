export const SQLITE_MIRROR_SCHEMA = [
  `
    CREATE TABLE IF NOT EXISTS cycle_runs (
      cycle_id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      session_phase TEXT NOT NULL,
      action TEXT NOT NULL,
      result_mode TEXT NOT NULL,
      reason TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      requested_position_sol REAL NOT NULL,
      quote_collected INTEGER NOT NULL,
      live_order_submitted INTEGER NOT NULL,
      confirmation_status TEXT NOT NULL,
      reconciliation_ok INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS orders (
      idempotency_key TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      confirmation_signature TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      requested_position_sol REAL NOT NULL,
      quoted_output_sol REAL NOT NULL,
      broadcast_status TEXT NOT NULL,
      confirmation_status TEXT NOT NULL,
      finality TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_orders_submission_id ON orders (submission_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders (updated_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS fills (
      fill_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      confirmation_signature TEXT NOT NULL,
      cycle_id TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      amount REAL NOT NULL,
      filled_sol REAL NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_fills_submission_id ON fills (submission_id, recorded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_fills_recorded_at ON fills (recorded_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS reconciliations (
      cycle_id TEXT PRIMARY KEY,
      wallet_sol REAL NOT NULL,
      journal_sol REAL NOT NULL,
      delta_sol REAL NOT NULL,
      token_delta_count INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      reason TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_reconciliations_recorded_at ON reconciliations (recorded_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS incidents (
      incident_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      severity TEXT NOT NULL,
      reason TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_incidents_recorded_at ON incidents (recorded_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS runtime_snapshots (
      snapshot_at TEXT PRIMARY KEY,
      runtime_mode TEXT NOT NULL,
      allow_new_opens INTEGER NOT NULL,
      flatten_only INTEGER NOT NULL,
      pending_submission INTEGER NOT NULL,
      circuit_reason TEXT NOT NULL,
      quote_failures INTEGER NOT NULL,
      reconcile_failures INTEGER NOT NULL,
      wallet_sol REAL,
      lp_value_sol REAL,
      unclaimed_fee_sol REAL,
      net_worth_sol REAL,
      open_position_count INTEGER
    )
  `
] as const;
