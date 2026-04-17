import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'node:sqlite';

const root = '/root/projects/Lightld';
const dbPath = path.join(root, 'state', 'lightld-observability.sqlite');
const ordersPath = path.join(root, 'tmp', 'journals', 'new-token-v1-live-orders.jsonl');
const fillsPath = path.join(root, 'tmp', 'journals', 'new-token-v1-live-fills.jsonl');

const db = new sqlite3.DatabaseSync(dbPath);

db.exec(`
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
);
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
);
`);

const insOrder = db.prepare(`INSERT INTO orders (
  idempotency_key, cycle_id, strategy_id, submission_id, confirmation_signature,
  pool_address, token_mint, token_symbol, action,
  requested_position_sol, quoted_output_sol, broadcast_status, confirmation_status, finality,
  created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(idempotency_key) DO UPDATE SET
  submission_id=excluded.submission_id,
  confirmation_signature=excluded.confirmation_signature,
  token_symbol=excluded.token_symbol,
  action=excluded.action,
  requested_position_sol=excluded.requested_position_sol,
  quoted_output_sol=excluded.quoted_output_sol,
  broadcast_status=excluded.broadcast_status,
  confirmation_status=excluded.confirmation_status,
  finality=excluded.finality,
  updated_at=excluded.updated_at`);

const insFill = db.prepare(`INSERT INTO fills (
  fill_id, submission_id, confirmation_signature, cycle_id, token_mint, token_symbol,
  side, amount, filled_sol, recorded_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(fill_id) DO UPDATE SET
  token_mint=excluded.token_mint,
  token_symbol=excluded.token_symbol,
  side=excluded.side,
  amount=excluded.amount,
  filled_sol=excluded.filled_sol,
  recorded_at=excluded.recorded_at`);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

const orders = readJsonl(ordersPath);
const fills = readJsonl(fillsPath);

let orderCount = 0;
let fillCount = 0;

db.exec('BEGIN');
for (const o of orders) {
  const action = ['hold','deploy','dca-out','add-lp','withdraw-lp','claim-fee','rebalance-lp'].includes(o.action || o.side) ? (o.action || o.side) : 'unknown';
  insOrder.run(
    o.idempotencyKey || `${o.cycleId || 'cycle'}:${o.poolAddress || 'pool'}:${o.createdAt || Date.now()}`,
    o.cycleId || '',
    o.strategyId || 'new-token-v1',
    o.submissionId || '',
    o.confirmationSignature || '',
    o.poolAddress || '',
    o.tokenMint || o.mint || '',
    o.tokenSymbol || o.symbol || '',
    action,
    Number(o.requestedPositionSol ?? o.outputSol ?? 0),
    Number(o.quotedOutputSol ?? o.outputSol ?? 0),
    o.broadcastStatus || (o.status === 'submitted' ? 'submitted' : 'pending'),
    o.confirmationStatus || o.status || 'unknown',
    o.finality || 'unknown',
    o.createdAt || o.recordedAt || new Date(0).toISOString(),
    o.updatedAt || o.recordedAt || o.createdAt || new Date(0).toISOString()
  );
  orderCount += 1;
}
for (let i = 0; i < fills.length; i++) {
  const f = fills[i];
  const side = ['buy','sell','add-lp','withdraw-lp','claim-fee','rebalance-lp'].includes(f.side) ? f.side : 'unknown';
  insFill.run(
    `${f.submissionId || 'fill'}:${f.recordedAt || i}:${i}`,
    f.submissionId || '',
    f.confirmationSignature || '',
    f.cycleId || '',
    f.tokenMint || f.mint || '',
    f.tokenSymbol || f.symbol || '',
    side,
    Number(f.amount ?? 0),
    Number(f.filledSol ?? f.requestedPositionSol ?? 0),
    f.recordedAt || new Date(0).toISOString()
  );
  fillCount += 1;
}
db.exec('COMMIT');
console.log(JSON.stringify({ orderCount, fillCount }));
