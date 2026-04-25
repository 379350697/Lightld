import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildDashboardHtml } from './dashboard-html.ts';
import { limitDecisionLogEntries } from './decision-log-limit.ts';
import { normalizeDashboardJournalFill } from './fill-normalization.ts';
import { paginateHistoryEntries } from './history-pagination.ts';
import {
  buildCashflowMetrics,
  buildEquityMetrics,
  buildHistoricalActivity
} from './dashboard-metrics.ts';
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
const HISTORY_PAGE_SIZE = 10;
const HISTORY_DECISION_FALLBACK_LINES = 1000;

// ── SQLite helpers (lazy, read-only) ──

let dbInstance: InstanceType<typeof import('node:sqlite').DatabaseSync> | null = null;
let databaseSyncCtorPromise: Promise<typeof import('node:sqlite').DatabaseSync | null> | null = null;

async function getDatabaseSyncCtor() {
  if (databaseSyncCtorPromise) {
    return databaseSyncCtorPromise;
  }

  databaseSyncCtorPromise = import('node:sqlite')
    .then((module) => module.DatabaseSync)
    .catch((error) => {
      console.error('[dashboard] failed to load node:sqlite', error);
      return null;
    });

  return databaseSyncCtorPromise;
}

async function getDb() {
  if (dbInstance) return dbInstance;

  try {
    const DatabaseSync = await getDatabaseSyncCtor();
    if (!DatabaseSync) {
      return null;
    }
    const db = new DatabaseSync(MIRROR_DB_PATH);
    db.exec('PRAGMA busy_timeout = 500;');
    dbInstance = db;
    return db;
  } catch (error) {
    console.error('[dashboard] failed to open sqlite mirror', error);
    return null;
  }
}

async function queryAll<T>(sql: string, ...params: Array<string | number | bigint | Uint8Array | null>): Promise<T[]> {
  try {
    const db = await getDb();
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

type ClosedPositionSnapshotRow = {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  poolAddress: string;
  positionAddress: string;
  openedAt: string;
  closedAt: string;
  depositSol: number;
  depositTokenAmount: number;
  withdrawSol: number;
  withdrawTokenAmount: number;
  withdrawTokenValueSol: number;
  feeSol: number;
  feeTokenAmount: number;
  feeTokenValueSol: number;
  pnlSol: number;
  source: 'solana-chain';
  confidence: 'exact' | 'partial';
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
  const [candidateScanCounts, watchlistSnapshotCounts] = await Promise.all([
    queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM candidate_scans'),
    queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM watchlist_snapshots')
  ]);
  const candidateScanCount = candidateScanCounts[0]?.count ?? 0;
  const watchlistSnapshotCount = watchlistSnapshotCounts[0]?.count ?? 0;
  const latestProposal = sortByIsoDesc(proposalCatalog ?? [], 'updatedAt', 'createdAt')[0] ?? null;
  const latestReview = sortByIsoDesc(outcomeLedger ?? [], 'reviewedAt')[0] ?? null;

  // Wallet SOL: prefer position-state.json (written every tick), fallback to SQLite reconciliations
  let walletSol: number | null = typeof position?.walletSol === 'number' ? position.walletSol : null;
  if (walletSol === null) {
    const recon = await queryAll<{ wallet_sol: number }>(
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
    const fallbackOrders = await queryAll<PositionFallbackOrderRow>(`
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
    `, activeMint, activePoolAddress);
    const fallbackOrder = fallbackOrders[0];

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
  tokenSymbol: string;
  openedAt: string | null;
  entrySol: number | null;
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
  const positionOrders = await queryAll<{
    chain_position_address: string;
    token_mint: string;
    pool_address: string;
    token_symbol: string;
    requested_position_sol: number;
    created_at: string;
    updated_at: string;
  }>(`
    SELECT
      chain_position_address,
      token_mint,
      pool_address,
      token_symbol,
      requested_position_sol,
      created_at,
      updated_at
    FROM orders
    WHERE action IN ('add-lp', 'deploy', 'rebalance-lp')
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT 500
  `);

  return walletLpPositions
    .filter((position) => position.hasLiquidity ?? true)
    .map((position) => {
      const matchedOrder = positionOrders.find((order) =>
        (order.chain_position_address && order.chain_position_address === position.positionAddress)
        || ((order.token_mint && order.token_mint === position.mint)
          && (order.pool_address && order.pool_address === position.poolAddress))
      );

      return {
        mint: position.mint,
        poolAddress: position.poolAddress,
        positionAddress: position.positionAddress,
        tokenSymbol: matchedOrder?.token_symbol ?? '',
        openedAt: matchedOrder?.updated_at || matchedOrder?.created_at || null,
        entrySol: typeof matchedOrder?.requested_position_sol === 'number' ? matchedOrder.requested_position_sol : null,
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
      };
    });
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

async function handlePnl(): Promise<PnlResponse> {
  const since30d = new Date(Date.now() - 30 * 86400000).toISOString();

  const fillRows = (await queryAll<{ side: string; filled_sol: number; recorded_at: string }>(`
    SELECT
      side,
      filled_sol,
      recorded_at
    FROM fills
    WHERE recorded_at >= ?
    ORDER BY recorded_at ASC
  `, since30d)).map((row) => ({
    side: row.side,
    filledSol: row.filled_sol,
    recordedAt: row.recorded_at
  }));

  const orderFallback = (await queryAll<{ action: string; requested_position_sol: number; created_at: string; updated_at: string }>(`
      SELECT
        action,
        requested_position_sol,
        created_at,
        updated_at
      FROM orders
      WHERE COALESCE(updated_at, created_at) >= ?
      ORDER BY COALESCE(updated_at, created_at) ASC
    `, since30d)).map((row) => ({
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

async function handleEquity(): Promise<EquityResponse> {
  const since30d = new Date(Date.now() - 30 * 86400000).toISOString();

  const rows = await queryAll<{
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
  lifecycle_key: string;
  idempotency_key: string;
  submission_id: string;
  open_intent_id: string;
  position_id: string;
  chain_position_address: string;
  token_mint: string;
  token_symbol: string;
  action: string;
  requested_position_sol: number;
  broadcast_status: string;
  confirmation_status: string;
  finality: string;
  created_at: string;
  updated_at: string;
};

async function handleOrders() {
  const rows = await queryAll<OrderRow>(`
    SELECT
      lifecycle_key, idempotency_key, submission_id, open_intent_id, position_id, chain_position_address, token_mint,
      token_symbol, action, requested_position_sol,
      broadcast_status, confirmation_status, finality, created_at, updated_at
    FROM orders
    ORDER BY updated_at DESC
    LIMIT 50
  `);

  if (rows.length > 0) {
    return rows.map(r => ({
      lifecycleKey: r.lifecycle_key,
      idempotencyKey: r.idempotency_key,
      submissionId: r.submission_id,
      openIntentId: r.open_intent_id,
      positionId: r.position_id,
      chainPositionAddress: r.chain_position_address,
      tokenMint: r.token_mint,
      tokenSymbol: r.token_symbol,
      action: r.action,
      requestedPositionSol: r.requested_position_sol,
      broadcastStatus: r.broadcast_status,
      confirmationStatus: r.confirmation_status,
      finality: r.finality,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  const journalRows = await readJournalEntries(`${STRATEGY_ID}-live-orders`, 200);
  return journalRows.reverse().map(r => ({
    lifecycleKey: String(r.lifecycleKey ?? ''),
    idempotencyKey: String(r.idempotencyKey ?? ''),
    submissionId: String(r.submissionId ?? ''),
    openIntentId: String(r.openIntentId ?? ''),
    positionId: String(r.positionId ?? ''),
    chainPositionAddress: String(r.chainPositionAddress ?? r.positionAddress ?? ''),
    tokenMint: String(r.tokenMint ?? ''),
    tokenSymbol: String(r.tokenSymbol ?? ''),
    action: String(r.side ?? r.action ?? 'unknown'),
    requestedPositionSol: Number(r.requestedPositionSol ?? r.outputSol ?? 0),
    broadcastStatus: String(r.broadcastStatus ?? 'pending'),
    confirmationStatus: String(r.confirmationStatus ?? r.status ?? 'unknown'),
    finality: String(r.finality ?? 'unknown'),
    createdAt: String(r.createdAt ?? ''),
    updatedAt: String(r.updatedAt ?? r.createdAt ?? ''),
  }));
}

type FillRow = {
  lifecycle_key: string;
  fill_id: string;
  submission_id: string;
  open_intent_id: string;
  position_id: string;
  chain_position_address: string;
  token_mint: string;
  token_symbol: string;
  side: string;
  amount: number;
  filled_sol: number;
  recorded_at: string;
  confirmation_status?: string;
};

async function handleFills(): Promise<Array<{
  lifecycleKey: string;
  fillId: string;
  submissionId: string;
  openIntentId: string;
  positionId: string;
  chainPositionAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  side: string;
  amount: number;
  filledSol: number;
  recordedAt: string;
  confirmationStatus: string;
}>> {
  const rows = await queryAll<FillRow>(`
    SELECT
      lifecycle_key, fill_id, submission_id, open_intent_id, position_id, chain_position_address, token_mint, token_symbol,
      side, amount, filled_sol, recorded_at, 'confirmed' AS confirmation_status
    FROM fills
    ORDER BY recorded_at DESC
    LIMIT 50
  `);

  if (rows.length > 0) {
    return rows.map(r => ({
      lifecycleKey: r.lifecycle_key,
      fillId: r.fill_id,
      submissionId: r.submission_id,
      openIntentId: r.open_intent_id,
      positionId: r.position_id,
      chainPositionAddress: r.chain_position_address,
      tokenMint: r.token_mint,
      tokenSymbol: r.token_symbol,
      side: r.side,
      amount: r.amount,
      filledSol: r.filled_sol,
      recordedAt: r.recorded_at,
      confirmationStatus: r.confirmation_status ?? 'confirmed',
    }));
  }

  const journalRows = await readJournalEntries(`${STRATEGY_ID}-live-fills`, 200);
  return journalRows.reverse().map((row) => ({
    lifecycleKey: String(row.lifecycleKey ?? ''),
    ...normalizeDashboardJournalFill(row),
    confirmationStatus: String(row.confirmationStatus ?? row.status ?? 'confirmed')
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
  const rows = await queryAll<IncidentRow>(`
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
  return limitDecisionLogEntries(entries).map(e => ({
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

function parseDecisionMetrics(reason: string) {
  const metrics = new Map<string, string>();

  for (const segment of reason.split(' | ')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key.length > 0) {
      metrics.set(key, value);
    }
  }

  const toNumber = (key: string) => {
    const value = metrics.get(key);
    if (!value || value === 'n/a') {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    entrySol: toNumber('entrySol'),
    lpCurrentValueSol: toNumber('lpCurrentValueSol'),
    lpUnclaimedFeeSol: toNumber('lpUnclaimedFeeSol'),
    lpNetPnlPct: toNumber('lpNetPnlPct'),
  };
}

async function readHistoryDecisionFallback() {
  const entries = await readJournalEntries(`${STRATEGY_ID}-decision-audit`, HISTORY_DECISION_FALLBACK_LINES);

  return entries
    .filter((entry) => {
      const action = String(entry.action ?? '');
      return action === 'withdraw-lp' || action === 'claim-fee' || action === 'rebalance-lp';
    })
    .map((entry) => {
      const parsed = parseDecisionMetrics(String(entry.engineReason ?? entry.reason ?? ''));
      return {
        tokenMint: String(entry.tokenMint ?? ''),
        tokenSymbol: String(entry.tokenSymbol ?? ''),
        action: String(entry.action ?? ''),
        recordedAt: String(entry.recordedAt ?? ''),
        ...parsed,
      };
    })
    .filter((entry) => entry.tokenMint.length > 0 && entry.recordedAt.length > 0);
}

async function handleClosedPositionSnapshots() {
  return queryAll<ClosedPositionSnapshotRow>(`
    SELECT
      wallet_address AS walletAddress,
      token_mint AS tokenMint,
      token_symbol AS tokenSymbol,
      pool_address AS poolAddress,
      position_address AS positionAddress,
      opened_at AS openedAt,
      closed_at AS closedAt,
      deposit_sol AS depositSol,
      deposit_token_amount AS depositTokenAmount,
      withdraw_sol AS withdrawSol,
      withdraw_token_amount AS withdrawTokenAmount,
      withdraw_token_value_sol AS withdrawTokenValueSol,
      fee_sol AS feeSol,
      fee_token_amount AS feeTokenAmount,
      fee_token_value_sol AS feeTokenValueSol,
      pnl_sol AS pnlSol,
      source,
      confidence
    FROM closed_position_snapshots
    ORDER BY closed_at DESC
  `);
}

async function handleHistory() {
  const [orders, fills, decisionFallback, chainSnapshots] = await Promise.all([
    handleOrders(),
    handleFills(),
    readHistoryDecisionFallback(),
    handleClosedPositionSnapshots()
  ]);

  const entries = buildHistoricalActivity({
    fills: fills.map((fill) => ({
      lifecycleKey: String(fill.lifecycleKey ?? ''),
      tokenMint: String(fill.tokenMint ?? ''),
      tokenSymbol: String(fill.tokenSymbol ?? ''),
      side: String(fill.side ?? ''),
      submissionId: String(fill.submissionId ?? ''),
      openIntentId: String(fill.openIntentId ?? ''),
      positionId: String(fill.positionId ?? ''),
      chainPositionAddress: String(fill.chainPositionAddress ?? ''),
      filledSol: Number(fill.filledSol ?? fill.amount ?? 0),
      recordedAt: String(fill.recordedAt ?? ''),
      confirmationStatus: String(fill.confirmationStatus ?? 'confirmed')
    })),
    orderFallback: orders.map((order) => ({
      lifecycleKey: String(order.lifecycleKey ?? ''),
      tokenMint: String(order.tokenMint ?? ''),
      tokenSymbol: String(order.tokenSymbol ?? ''),
      action: String(order.action ?? ''),
      submissionId: String(order.submissionId ?? ''),
      idempotencyKey: String(order.idempotencyKey ?? ''),
      openIntentId: String(order.openIntentId ?? ''),
      positionId: String(order.positionId ?? ''),
      chainPositionAddress: String(order.chainPositionAddress ?? ''),
      requestedPositionSol: Number(order.requestedPositionSol ?? 0),
      broadcastStatus: String(order.broadcastStatus ?? 'pending'),
      confirmationStatus: String(order.confirmationStatus ?? 'unknown'),
      createdAt: String(order.createdAt ?? ''),
      updatedAt: String(order.updatedAt ?? order.createdAt ?? '')
    })),
    decisionFallback,
    chainSnapshots
  });

  return paginateHistoryEntries(entries, {
    page: 1,
    pageSize: HISTORY_PAGE_SIZE
  });
}

function parsePositiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

async function handleHistoryPage(input?: {
  page?: number;
  pageSize?: number;
}) {
  const [orders, fills, decisionFallback, chainSnapshots] = await Promise.all([
    handleOrders(),
    handleFills(),
    readHistoryDecisionFallback(),
    handleClosedPositionSnapshots()
  ]);

  const entries = buildHistoricalActivity({
    fills: fills.map((fill) => ({
      lifecycleKey: String(fill.lifecycleKey ?? ''),
      tokenMint: String(fill.tokenMint ?? ''),
      tokenSymbol: String(fill.tokenSymbol ?? ''),
      side: String(fill.side ?? ''),
      submissionId: String(fill.submissionId ?? ''),
      openIntentId: String(fill.openIntentId ?? ''),
      positionId: String(fill.positionId ?? ''),
      chainPositionAddress: String(fill.chainPositionAddress ?? ''),
      filledSol: Number(fill.filledSol ?? fill.amount ?? 0),
      recordedAt: String(fill.recordedAt ?? ''),
      confirmationStatus: String(fill.confirmationStatus ?? 'confirmed')
    })),
    orderFallback: orders.map((order) => ({
      lifecycleKey: String(order.lifecycleKey ?? ''),
      tokenMint: String(order.tokenMint ?? ''),
      tokenSymbol: String(order.tokenSymbol ?? ''),
      action: String(order.action ?? ''),
      submissionId: String(order.submissionId ?? ''),
      idempotencyKey: String(order.idempotencyKey ?? ''),
      openIntentId: String(order.openIntentId ?? ''),
      positionId: String(order.positionId ?? ''),
      chainPositionAddress: String(order.chainPositionAddress ?? ''),
      requestedPositionSol: Number(order.requestedPositionSol ?? 0),
      broadcastStatus: String(order.broadcastStatus ?? 'pending'),
      confirmationStatus: String(order.confirmationStatus ?? 'unknown'),
      createdAt: String(order.createdAt ?? ''),
      updatedAt: String(order.updatedAt ?? order.createdAt ?? '')
    })),
    decisionFallback,
    chainSnapshots
  });

  return paginateHistoryEntries(entries, {
    page: input?.page ?? 1,
    pageSize: input?.pageSize ?? HISTORY_PAGE_SIZE
  });
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
  const requestUrl = new URL(url, `http://127.0.0.1:${PORT}`);

  try {
    if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
      return sendHtml(res);
    }

    if (requestUrl.pathname === '/api/status') {
      return sendJson(res, await handleStatus());
    }

    if (requestUrl.pathname === '/api/pnl') {
      return sendJson(res, await handlePnl());
    }

    if (requestUrl.pathname === '/api/overview') {
      const [status, positions, pnl, equity, orders, fills, incidents, logs, history] = await Promise.all([
        handleStatus(),
        handlePositions(),
        handlePnl(),
        handleEquity(),
        handleOrders(),
        handleFills(),
        handleIncidents(),
        handleLogs(),
        handleHistory()
      ]);

      return sendJson(res, {
        status,
        positions,
        pnl,
        equity,
        orders,
        fills,
        incidents,
        logs,
        history,
      });
    }

    if (requestUrl.pathname === '/api/positions') {
      return sendJson(res, await handlePositions());
    }

    if (requestUrl.pathname === '/api/equity') {
      return sendJson(res, await handleEquity());
    }

    if (requestUrl.pathname === '/api/orders') {
      return sendJson(res, await handleOrders());
    }

    if (requestUrl.pathname === '/api/fills') {
      return sendJson(res, await handleFills());
    }

    if (requestUrl.pathname === '/api/history') {
      return sendJson(res, await handleHistoryPage({
        page: parsePositiveInteger(requestUrl.searchParams.get('page'), 1),
        pageSize: parsePositiveInteger(requestUrl.searchParams.get('pageSize'), HISTORY_PAGE_SIZE)
      }));
    }

    if (requestUrl.pathname === '/api/incidents') {
      return sendJson(res, await handleIncidents());
    }

    if (requestUrl.pathname === '/api/logs') {
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
