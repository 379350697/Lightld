import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildDashboardHtml } from './dashboard-html.ts';
import { buildCashflowMetrics, buildEquityMetrics } from './dashboard-metrics.ts';
import { resolveEvolutionPaths } from '../evolution/index.ts';
import { readRotatedJsonTail } from '../journals/jsonl-writer.ts';

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

async function readJournalEntries(baseName: string, maxLines: number) {
  return readRotatedJsonTail<Record<string, unknown>>(join(JOURNAL_ROOT_DIR, `${baseName}.jsonl`), maxLines);
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
    currentPrice?: number;
    lowerPrice?: number;
    upperPrice?: number;
    priceProgress?: number;
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
  const evolutionPaths = resolveEvolutionPaths(STRATEGY_ID === 'large-pool-v1' ? 'large-pool-v1' : 'new-token-v1', join(STATE_ROOT_DIR, 'evolution'));
  const [health, position, runtime] = await Promise.all([
    readJsonSafe<Record<string, unknown>>(join(STATE_ROOT_DIR, 'health.json')),
    readJsonSafe<Record<string, unknown>>(join(STATE_ROOT_DIR, 'position-state.json')),
    readJsonSafe<Record<string, unknown>>(join(STATE_ROOT_DIR, 'runtime-state.json')),
  ]);
  const [proposalCatalog, approvalQueue] = await Promise.all([
    readJsonSafe<Array<Record<string, unknown>>>(evolutionPaths.proposalCatalogPath),
    readJsonSafe<Array<Record<string, unknown>>>(evolutionPaths.approvalQueuePath)
  ]);
  const [outcomeLedger, evidenceSnapshot] = await Promise.all([
    readJsonSafe<Array<Record<string, unknown>>>(evolutionPaths.outcomeLedgerPath),
    readJsonSafe<Record<string, unknown>>(evolutionPaths.evidenceSnapshotPath)
  ]);
  const candidateScanCount = queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM candidate_scans')[0]?.count ?? 0;
  const watchlistSnapshotCount = queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM watchlist_snapshots')[0]?.count ?? 0;
  const latestProposal = sortByIsoDesc(proposalCatalog ?? [], 'updatedAt', 'createdAt')[0] ?? null;
  const latestReview = sortByIsoDesc(outcomeLedger ?? [], 'reviewedAt')[0] ?? null;

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
      const orderJournalRows = await readJournalEntries(`${STRATEGY_ID}-live-orders`, 200);
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
    evolution: {
      proposalCount: proposalCatalog?.length ?? 0,
      approvalQueueCount: approvalQueue?.length ?? 0,
      mirroredCandidateScanCount: candidateScanCount,
      mirroredWatchlistSnapshotCount: watchlistSnapshotCount,
      latestEvidenceWindow: typeof evidenceSnapshot?.timeWindowLabel === 'string' ? evidenceSnapshot.timeWindowLabel : 'all-available',
      latestCoverageScore: typeof evidenceSnapshot?.coverageScore === 'number' ? evidenceSnapshot.coverageScore : null,
      latestRegimeScore: typeof evidenceSnapshot?.regimeScore === 'number' ? evidenceSnapshot.regimeScore : null,
      latestReadinessScore: typeof evidenceSnapshot?.proposalReadinessScore === 'number'
        ? evidenceSnapshot.proposalReadinessScore
        : null,
      latestProposalPath: typeof latestProposal?.targetPath === 'string' ? latestProposal.targetPath : '',
      latestProposalStatus: typeof latestProposal?.status === 'string' ? latestProposal.status : '',
      latestReviewStatus: typeof latestReview?.status === 'string' ? latestReview.status : '',
      latestReviewProposalId: typeof latestReview?.proposalId === 'string' ? latestReview.proposalId : ''
    }
  };
}

function sortByIsoDesc(rows: Array<Record<string, unknown>>, ...keys: string[]) {
  return [...rows].sort((left, right) => {
    const leftIso = keys.map((key) => String(left[key] ?? '')).find((value) => value.length > 0) ?? '';
    const rightIso = keys.map((key) => String(right[key] ?? '')).find((value) => value.length > 0) ?? '';

    return rightIso.localeCompare(leftIso);
  });
}

type PositionResponse = Array<{
  mint: string;
  poolAddress: string;
  positionAddress: string;
  currentValueSol: number | null;
  unclaimedFeeSol: number | null;
  currentPrice: number | null;
  lowerPrice: number | null;
  upperPrice: number | null;
  priceProgress: number | null;
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
      currentPrice: typeof position.currentPrice === 'number' ? position.currentPrice : null,
      lowerPrice: typeof position.lowerPrice === 'number' ? position.lowerPrice : null,
      upperPrice: typeof position.upperPrice === 'number' ? position.upperPrice : null,
      priceProgress: typeof position.priceProgress === 'number' ? position.priceProgress : null,
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
  metricType?: 'realized_cashflow';
  totalCashflowSol?: number;
  todayCashflowSol?: number;
  monthCashflowSol?: number;
  dailyCashflow?: Array<{ date: string; cashflowSol: number }>;
  totalPnl: number;
  todayPnl: number;
  monthPnl: number;
  dailyPnl: Array<{ date: string; pnl: number }>;
};

type EquityResponse = ReturnType<typeof buildEquityMetrics>;

function handlePnl(): PnlResponse {
  const since30d = new Date(Date.now() - 30 * 86400000).toISOString();

  const fillRows = queryAll<{ side: string; filled_sol: number; recorded_at: string }>(`
    SELECT
      side,
      filled_sol,
      recorded_at
    FROM fills
    WHERE recorded_at >= ?
    ORDER BY recorded_at ASC
  `, since30d).map((row) => ({
    side: row.side,
    filledSol: row.filled_sol,
    recordedAt: row.recorded_at
  }));

  const orderFallback = queryAll<{ action: string; requested_position_sol: number; created_at: string; updated_at: string }>(`
      SELECT
        action,
        requested_position_sol,
        created_at,
        updated_at
      FROM orders
      WHERE COALESCE(updated_at, created_at) >= ?
      ORDER BY COALESCE(updated_at, created_at) ASC
    `, since30d).map((row) => ({
      action: row.action,
      requestedPositionSol: row.requested_position_sol,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

  return buildCashflowMetrics({
    fills: fillRows,
    orderFallback
  });
}

function handleEquity(): EquityResponse {
  const since30d = new Date(Date.now() - 30 * 86400000).toISOString();

  const rows = queryAll<{
    snapshot_at: string;
    wallet_sol: number | null;
    lp_value_sol: number | null;
    unclaimed_fee_sol: number | null;
    net_worth_sol: number | null;
    open_position_count: number | null;
  }>(`
    SELECT
      snapshots.snapshot_at,
      snapshots.wallet_sol,
      snapshots.lp_value_sol,
      snapshots.unclaimed_fee_sol,
      snapshots.net_worth_sol,
      snapshots.open_position_count
    FROM runtime_snapshots AS snapshots
    INNER JOIN (
      SELECT
        MAX(snapshot_at) AS snapshot_at
      FROM runtime_snapshots
      WHERE snapshot_at >= ?
        AND net_worth_sol IS NOT NULL
      GROUP BY substr(snapshot_at, 1, 10)
    ) AS latest
      ON latest.snapshot_at = snapshots.snapshot_at
    ORDER BY snapshots.snapshot_at ASC
  `, since30d);

  return buildEquityMetrics({
    snapshots: rows.map((row) => ({
      snapshotAt: row.snapshot_at,
      walletSol: row.wallet_sol,
      lpValueSol: row.lp_value_sol,
      unclaimedFeeSol: row.unclaimed_fee_sol,
      netWorthSol: row.net_worth_sol,
      openPositionCount: row.open_position_count
    }))
  });
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

  const journalRows = await readJournalEntries(`${STRATEGY_ID}-live-orders`, 200);
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

  const journalRows = await readJournalEntries(`${STRATEGY_ID}-live-fills`, 200);
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

  const journalRows = await readJournalEntries(`${STRATEGY_ID}-live-incidents`, 200);
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
  const entries = await readJournalEntries(`${STRATEGY_ID}-decision-audit`, 200);
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
        equity: handleEquity(),
        orders: await handleOrders(),
        fills: await handleFills(),
        incidents: await handleIncidents(),
        logs: await handleLogs(),
      });
    }

    if (url === '/api/positions') {
      return sendJson(res, await handlePositions());
    }

    if (url === '/api/equity') {
      return sendJson(res, handleEquity());
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
