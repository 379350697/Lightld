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
  `,
  `
    CREATE TABLE IF NOT EXISTS candidate_scans (
      scan_id TEXT PRIMARY KEY,
      captured_at TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      pool_count INTEGER NOT NULL,
      prefiltered_count INTEGER NOT NULL,
      post_lp_count INTEGER NOT NULL,
      post_safety_count INTEGER NOT NULL,
      eligible_selection_count INTEGER NOT NULL,
      scan_window_open INTEGER NOT NULL,
      active_positions_count INTEGER NOT NULL,
      selected_token_mint TEXT NOT NULL,
      selected_pool_address TEXT NOT NULL,
      blocked_reason TEXT NOT NULL,
      candidate_count INTEGER NOT NULL,
      raw_json TEXT NOT NULL
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_candidate_scans_captured_at ON candidate_scans (captured_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS watchlist_snapshots (
      watch_id TEXT NOT NULL,
      tracked_since TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      observation_at TEXT NOT NULL,
      window_label TEXT NOT NULL,
      current_value_sol REAL,
      liquidity_usd REAL,
      active_bin_id INTEGER,
      lower_bin_id INTEGER,
      upper_bin_id INTEGER,
      bin_count INTEGER,
      funded_bin_count INTEGER,
      sol_depleted_bins INTEGER,
      unclaimed_fee_sol REAL,
      has_inventory INTEGER NOT NULL,
      has_lp_position INTEGER NOT NULL,
      source_reason TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (watch_id, tracked_since, window_label)
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_watchlist_snapshots_observation_at ON watchlist_snapshots (observation_at DESC)`
] as const;
