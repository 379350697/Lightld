import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildDashboardHtml } from './dashboard-html.ts';

// ── Configuration ──

const PORT = Number(process.env.DASHBOARD_PORT ?? 8899);
const STATE_ROOT_DIR = process.env.LIVE_STATE_DIR ?? 'state';
const JOURNAL_ROOT_DIR = process.env.LIVE_JOURNAL_DIR ?? join('tmp', 'journals');
const MIRROR_DB_PATH = process.env.LIVE_DB_MIRROR_PATH ?? join(STATE_ROOT_DIR, 'lightld-observability.sqlite');
const STRATEGY_ID = process.env.LIVE_STRATEGY_ID ?? 'new-token-v1';
const ACCOUNT_STATE_URL = process.env.LIVE_ACCOUNT_STATE_URL ?? 'http://127.0.0.1:8791/account-state';
const LIVE_AUTH_TOKEN = process.env.LIVE_AUTH_TOKEN ?? '';

// ── SQLite helpers (lazy, read-only) ──

let dbInstance: InstanceType<typeof import('node:sqlite').DatabaseSync> | null = null;

function getDb() {
  if (dbInstance) return dbInstance;

  try {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(MIRROR_DB_PATH);
    db.exec('PRAGMA busy_timeout = 500;');
    dbInstance = db;
    return db;
  } catch (error) {
    console.error('[dashboard] failed to open sqlite mirror', error);
    return null;
  }
}

function queryAll<T>(sql: string, ...params: Array<string | number | bigint | Uint8Array | null>): T[] {
  try {
    const db = getDb();
    if (!db) return [];
    return db.prepare(sql).all(...params) as T[];
  } catch (error) {
    console.error('[dashboard] sqlite query failed', { sql, error });
    return [];
  }
}

// ── File readers ──

async function readJsonSafe<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function fetchJsonSafe<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: LIVE_AUTH_TOKEN ? { authorization: `Bearer ${LIVE_AUTH_TOKEN}` } : undefined,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json() as T;
  } catch {
    return null;
  }
}

async function readJsonlTail(path: string, maxLines: number): Promise<Record<string, unknown>[]> {
  try {
    const content = await readFile(path, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-maxLines);
    return tail.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

async function findLatestJournalFile(prefix: string): Promise<string | null> {
  try {
    const files = await readdir(JOURNAL_ROOT_DIR);
    const matching = files
      .filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .sort((a, b) => b.localeCompare(a));
    return matching.length > 0 ? join(JOURNAL_ROOT_DIR, matching[0]) : null;
  } catch {
    return null;
  }
}

async function readLatestJournalEntries(prefix: string, maxLines: number) {
  const path = await findLatestJournalFile(prefix);
  if (!path) return [];
  return readJsonlTail(path, maxLines);
}

// ── API handlers ──

type StatusResponse = Record<string, unknown>;

type AccountStateSnapshot = {
  walletLpPositions?: Array<{
    poolAddress: string;
    positionAddress: string;
    mint: string;
    lowerBinId?: number;
    upperBinId?: number;
    activeBinId?: number;
    binCount?: number;
    fundedBinCount?: number;
    solSide?: string;
    solDepletedBins?: number;
    currentValueSol?: number;
    unclaimedFeeSol?: number;
    hasLiquidity?: boolean;
    hasClaimableFees?: boolean;
  }>;
};

type PositionFallbackOrderRow = {
  token_mint: string;
  pool_address: string;
  token_symbol: string;
  requested_position_sol: number;
  created_at: string;
  updated_at: string;
};

async function handleStatus(): Promise<StatusResponse> {
  const [health, position, runtime] = await Promise.all([
    readJsonSafe<Record<string, unknown>>(join(STATE_ROOT_DIR, 'health.json')),
    readJsonSafe<Record<string, unknown>>(join(STATE_ROOT_DIR, 'position-state.json')),
    readJsonSafe<Record<string, unknown>>(join(STATE_ROOT_DIR, 'runtime-state.json')),
  ]);

  // Wallet SOL: prefer position-state.json (written every tick), fallback to SQLite reconciliations
  let walletSol: number | null = typeof position?.walletSol === 'number' ? position.walletSol : null;
  if (walletSol === null) {
    const recon = queryAll<{ wallet_sol: number }>(
      'SELECT wallet_sol FROM reconciliations ORDER BY recorded_at DESC LIMIT 1'
    );
    if (recon.length > 0) {
      walletSol = recon[0].wallet_sol;
    }
  }

  const activeMint = typeof position?.activeMint === 'string' ? position.activeMint : '';
  const activePoolAddress = typeof position?.activePoolAddress === 'string' ? position.activePoolAddress : '';

  let entrySol = typeof position?.entrySol === 'number' ? position.entrySol : null;
  let openedAt = typeof position?.openedAt === 'string' ? position.openedAt : null;
  let activeSymbol = '';

  if (activeMint || activePoolAddress) {
    const fallbackOrder = queryAll<PositionFallbackOrderRow>(`
      SELECT
        token_mint,
        pool_address,
        token_symbol,
        requested_position_sol,
        created_at,
        updated_at
      FROM orders
      WHERE token_mint = ? OR pool_address = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `, activeMint, activePoolAddress)[0];

    if (fallbackOrder) {
      activeSymbol = fallbackOrder.token_symbol ?? '';
      if (entrySol === null && typeof fallbackOrder.requested_position_sol === 'number') {
        entrySol = fallbackOrder.requested_position_sol;
      }
      if (!openedAt) {
        openedAt = fallbackOrder.updated_at || fallbackOrder.created_at || null;
      }
    }

    if (entrySol === null || !openedAt || !activeSymbol) {
      const orderJournalRows = await readLatestJournalEntries(`${STRATEGY_ID}-live-orders`, 200);
      const matchedJournalOrder = [...orderJournalRows].reverse().find(row => {
        const tokenMint = String(row.tokenMint ?? '');
        const poolAddress = String(row.poolAddress ?? '');
        return (activeMint && tokenMint === activeMint) || (activePoolAddress && poolAddress === activePoolAddress);
      });

      if (matchedJournalOrder) {
        if (!activeSymbol) {
          activeSymbol = String(matchedJournalOrder.tokenSymbol ?? '');
        }
        if (entrySol === null) {
          const journalEntrySol = Number(matchedJournalOrder.requestedPositionSol ?? matchedJournalOrder.outputSol ?? 0);
          if (Number.isFinite(journalEntrySol) && journalEntrySol > 0) {
            entrySol = journalEntrySol;
          }
        }
        if (!openedAt) {
          openedAt = String(matchedJournalOrder.createdAt ?? '') || null;
        }
      }
    }
  }

  return {
    mode: health?.mode ?? runtime?.mode ?? 'unknown',
    circuitReason: health?.circuitReason ?? runtime?.circuitReason ?? '',
    allowNewOpens: health?.allowNewOpens ?? false,
    flattenOnly: health?.flattenOnly ?? false,
    pendingSubmission: health?.pendingSubmission ?? false,
    lastSuccessfulTickAt: health?.lastSuccessfulTickAt ?? '',
    dependencyHealth: health?.dependencyHealth ?? {},
    updatedAt: health?.updatedAt ?? runtime?.updatedAt ?? '',

    // Position
    lifecycleState: position?.lifecycleState ?? 'closed',
    lastAction: position?.lastAction ?? '',
    lastReason: position?.lastReason ?? '',
    activeMint,
    activePoolAddress,
    activeSymbol,
    entrySol,
    openedAt,
    lastClosedMint: position?.lastClosedMint ?? '',
    lastClosedAt: position?.lastClosedAt ?? '',

    walletSol,
  };
}

type PositionResponse = Array<{
  mint: string;
  poolAddress: string;
  positionAddress: string;
  currentValueSol: number | null;
  unclaimedFeeSol: number | null;
  binCount: number | null;
  fundedBinCount: number | null;
  lowerBinId: number | null;
  upperBinId: number | null;
  activeBinId: number | null;
  solSide: string;
  solDepletedBins: number | null;
  hasLiquidity: boolean;
  hasClaimableFees: boolean;
}>;

async function handlePositions(): Promise<PositionResponse> {
  const accountState =
    await readJsonSafe<AccountStateSnapshot>(join(STATE_ROOT_DIR, 'account-state.json'))
    ?? await fetchJsonSafe<AccountStateSnapshot>(ACCOUNT_STATE_URL);
  const walletLpPositions = accountState?.walletLpPositions ?? [];

  return walletLpPositions
    .filter((position) => position.hasLiquidity ?? true)
    .map((position) => ({
      mint: position.mint,
      poolAddress: position.poolAddress,
      positionAddress: position.positionAddress,
      currentValueSol: typeof position.currentValueSol === 'number' ? position.currentValueSol : null,
      unclaimedFeeSol: typeof position.unclaimedFeeSol === 'number' ? position.unclaimedFeeSol : null,
      binCount: typeof position.binCount === 'number' ? position.binCount : null,
      fundedBinCount: typeof position.fundedBinCount === 'number' ? position.fundedBinCount : null,
      lowerBinId: typeof position.lowerBinId === 'number' ? position.lowerBinId : null,
      upperBinId: typeof position.upperBinId === 'number' ? position.upperBinId : null,
      activeBinId: typeof position.activeBinId === 'number' ? position.activeBinId : null,
      solSide: position.solSide ?? '',
      solDepletedBins: typeof position.solDepletedBins === 'number' ? position.solDepletedBins : null,
      hasLiquidity: Boolean(position.hasLiquidity ?? true),
      hasClaimableFees: Boolean(position.hasClaimableFees ?? false),
    }));
}

type PnlResponse = {
  totalPnl: number;
  todayPnl: number;
  monthPnl: number;
  dailyPnl: Array<{ date: string; pnl: number }>;
};

function handlePnl(): PnlResponse {
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  // Total PnL: sum of exit fills minus entry fills
  const totalEntry = queryAll<{ total: number }>(
    "SELECT COALESCE(SUM(filled_sol), 0) AS total FROM fills WHERE side IN ('buy', 'add-lp')"
  );
  const totalExit = queryAll<{ total: number }>(
    "SELECT COALESCE(SUM(filled_sol), 0) AS total FROM fills WHERE side IN ('sell', 'withdraw-lp', 'claim-fee')"
  );

  const entryTotal = totalEntry[0]?.total ?? 0;
  const exitTotal = totalExit[0]?.total ?? 0;
  const totalPnl = exitTotal - entryTotal;

  // Today PnL
  const todayEntry = queryAll<{ total: number }>(
    "SELECT COALESCE(SUM(filled_sol), 0) AS total FROM fills WHERE side IN ('buy', 'add-lp') AND recorded_at >= ?",
    today + 'T00:00:00.000Z'
  );
  const todayExit = queryAll<{ total: number }>(
    "SELECT COALESCE(SUM(filled_sol), 0) AS total FROM fills WHERE side IN ('sell', 'withdraw-lp', 'claim-fee') AND recorded_at >= ?",
    today + 'T00:00:00.000Z'
  );
  const todayPnl = (todayExit[0]?.total ?? 0) - (todayEntry[0]?.total ?? 0);

  // Month PnL
  const monthEntry = queryAll<{ total: number }>(
    "SELECT COALESCE(SUM(filled_sol), 0) AS total FROM fills WHERE side IN ('buy', 'add-lp') AND recorded_at >= ?",
    month + '-01T00:00:00.000Z'
  );
  const monthExit = queryAll<{ total: number }>(
    "SELECT COALESCE(SUM(filled_sol), 0) AS total FROM fills WHERE side IN ('sell', 'withdraw-lp', 'claim-fee') AND recorded_at >= ?",
    month + '-01T00:00:00.000Z'
  );
  const monthPnl = (monthExit[0]?.total ?? 0) - (monthEntry[0]?.total ?? 0);

  // Daily PnL for last 30 days
  const dailyRows = queryAll<{ date: string; entry_sol: number; exit_sol: number }>(`
    SELECT
      SUBSTR(recorded_at, 1, 10) AS date,
      COALESCE(SUM(CASE WHEN side IN ('buy', 'add-lp') THEN filled_sol ELSE 0 END), 0) AS entry_sol,
      COALESCE(SUM(CASE WHEN side IN ('sell', 'withdraw-lp', 'claim-fee') THEN filled_sol ELSE 0 END), 0) AS exit_sol
    FROM fills
    WHERE recorded_at >= ?
    GROUP BY SUBSTR(recorded_at, 1, 10)
    ORDER BY date ASC
  `, new Date(Date.now() - 30 * 86400000).toISOString());

  const dailyPnl = dailyRows.map(r => ({
    date: r.date,
    pnl: r.exit_sol - r.entry_sol
  }));

  return { totalPnl, todayPnl, monthPnl, dailyPnl };
}

type OrderRow = {
  idempotency_key: string;
  submission_id: string;
  token_mint: string;
  token_symbol: string;
  action: string;
  requested_position_sol: number;
  confirmation_status: string;
  finality: string;
  created_at: string;
  updated_at: string;
};

async function handleOrders() {
  const rows = queryAll<OrderRow>(`
    SELECT
      idempotency_key, submission_id, token_mint,
      token_symbol, action, requested_position_sol,
      confirmation_status, finality, created_at, updated_at
    FROM orders
    ORDER BY updated_at DESC
    LIMIT 50
  `);

  if (rows.length > 0) {
    return rows.map(r => ({
      idempotencyKey: r.idempotency_key,
      submissionId: r.submission_id,
      tokenMint: r.token_mint,
      tokenSymbol: r.token_symbol,
      action: r.action,
      requestedPositionSol: r.requested_position_sol,
      confirmationStatus: r.confirmation_status,
      finality: r.finality,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  const journalRows = await readLatestJournalEntries(`${STRATEGY_ID}-live-orders`, 200);
  return journalRows.reverse().map(r => ({
    idempotencyKey: String(r.idempotencyKey ?? ''),
    submissionId: String(r.submissionId ?? ''),
    tokenMint: String(r.tokenMint ?? ''),
    tokenSymbol: String(r.tokenSymbol ?? ''),
    action: String(r.side ?? r.action ?? 'unknown'),
    requestedPositionSol: Number(r.requestedPositionSol ?? r.outputSol ?? 0),
    confirmationStatus: String(r.confirmationStatus ?? r.status ?? 'unknown'),
    finality: String(r.finality ?? 'unknown'),
    createdAt: String(r.createdAt ?? ''),
    updatedAt: String(r.updatedAt ?? r.createdAt ?? ''),
  }));
}

type FillRow = {
  fill_id: string;
  submission_id: string;
  token_mint: string;
  token_symbol: string;
  side: string;
  amount: number;
  filled_sol: number;
  recorded_at: string;
};

async function handleFills() {
  const rows = queryAll<FillRow>(`
    SELECT
      fill_id, submission_id, token_mint, token_symbol,
      side, amount, filled_sol, recorded_at
    FROM fills
    ORDER BY recorded_at DESC
    LIMIT 50
  `);

  if (rows.length > 0) {
    return rows.map(r => ({
      fillId: r.fill_id,
      submissionId: r.submission_id,
      tokenMint: r.token_mint,
      tokenSymbol: r.token_symbol,
      side: r.side,
      amount: r.amount,
      filledSol: r.filled_sol,
      recordedAt: r.recorded_at,
    }));
  }

  const journalRows = await readLatestJournalEntries(`${STRATEGY_ID}-live-fills`, 200);
  return journalRows.reverse().map(r => ({
    fillId: String(r.fillId ?? r.submissionId ?? r.cycleId ?? ''),
    submissionId: String(r.submissionId ?? ''),
    tokenMint: String(r.tokenMint ?? ''),
    tokenSymbol: String(r.tokenSymbol ?? ''),
    side: String(r.side ?? 'unknown'),
    amount: Number(r.amount ?? 0),
    filledSol: Number(r.filledSol ?? 0),
    recordedAt: String(r.recordedAt ?? ''),
  }));
}

type IncidentRow = {
  incident_id: string;
  cycle_id: string;
  stage: string;
  severity: string;
  reason: string;
  runtime_mode: string;
  token_symbol: string;
  recorded_at: string;
};

async function handleIncidents() {
  const rows = queryAll<IncidentRow>(`
    SELECT
      incident_id, cycle_id, stage, severity,
      reason, runtime_mode, token_symbol, recorded_at
    FROM incidents
    ORDER BY recorded_at DESC
    LIMIT 50
  `);

  if (rows.length > 0) {
    return rows.map(r => ({
      incidentId: r.incident_id,
      cycleId: r.cycle_id,
      stage: r.stage,
      severity: r.severity,
      reason: r.reason,
      runtimeMode: r.runtime_mode,
      tokenSymbol: r.token_symbol,
      recordedAt: r.recorded_at,
    }));
  }

  const journalRows = await readLatestJournalEntries(`${STRATEGY_ID}-live-incidents`, 200);
  return journalRows.reverse().map(r => ({
    incidentId: String(r.incidentId ?? r.cycleId ?? ''),
    cycleId: String(r.cycleId ?? ''),
    stage: String(r.stage ?? ''),
    severity: String(r.severity ?? 'warning'),
    reason: String(r.reason ?? ''),
    runtimeMode: String(r.runtimeMode ?? ''),
    tokenSymbol: String(r.tokenSymbol ?? ''),
    recordedAt: String(r.recordedAt ?? ''),
  }));
}

async function handleLogs() {
  const path = await findLatestJournalFile(`${STRATEGY_ID}-decision-audit`);
  if (!path) return [];

  const entries = await readJsonlTail(path, 200);
  return entries.reverse().map(e => ({
    recordedAt: e.recordedAt ?? '',
    action: e.action ?? '',
    stage: e.stage ?? '',
    reason: e.reason ?? '',
    tokenSymbol: e.tokenSymbol ?? '',
    tokenMint: e.tokenMint ?? '',
    mode: e.mode ?? '',
    runtimeMode: e.runtimeMode ?? '',
    liveOrderSubmitted: e.liveOrderSubmitted ?? false,
  }));
}

// ── HTTP Server ──

const cachedHtml = buildDashboardHtml();

function sendJson(res: ServerResponse, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(cachedHtml),
    'Cache-Control': 'no-store',
  });
  res.end(cachedHtml);
}

function sendNotFound(res: ServerResponse) {
  res.writeHead(404);
  res.end('Not Found');
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? '/';

  try {
    if (url === '/' || url === '/index.html') {
      return sendHtml(res);
    }

    if (url === '/api/status') {
      return sendJson(res, await handleStatus());
    }

    if (url === '/api/pnl') {
      return sendJson(res, handlePnl());
    }

    if (url === '/api/overview') {
      return sendJson(res, {
        status: await handleStatus(),
        positions: await handlePositions(),
        pnl: handlePnl(),
        orders: await handleOrders(),
        fills: await handleFills(),
        incidents: await handleIncidents(),
      });
    }

    if (url === '/api/positions') {
      return sendJson(res, await handlePositions());
    }

    if (url === '/api/orders') {
      return sendJson(res, await handleOrders());
    }

    if (url === '/api/fills') {
      return sendJson(res, await handleFills());
    }

    if (url === '/api/incidents') {
      return sendJson(res, await handleIncidents());
    }

    if (url === '/api/logs') {
      return sendJson(res, await handleLogs());
    }

    sendNotFound(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
}

// ── Start ──

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   Lightld Dashboard                  ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝`);
  console.log(`  State:    ${STATE_ROOT_DIR}`);
  console.log(`  Journals: ${JOURNAL_ROOT_DIR}`);
  console.log(`  Mirror:   ${MIRROR_DB_PATH}`);
  console.log(`  Strategy: ${STRATEGY_ID}\n`);
});
