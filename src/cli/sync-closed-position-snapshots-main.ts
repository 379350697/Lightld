import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadSolanaExecutionConfig } from '../execution/solana/solana-execution-config.ts';
import { SolanaRpcClient } from '../execution/solana/solana-rpc-client.ts';
import { loadSolanaKeypair } from '../execution/solana/solana-transaction-signer.ts';
import { fetchMeteoraOhlcv } from '../ingest/meteora/client.ts';
import {
  buildClosedPositionOrderSeeds,
  buildClosedPositionSnapshotsFromTrustedFills,
  syncClosedPositionSnapshots,
  type ClosedPositionOrderSeedRow,
  type TrustedClosedPositionFillRow
} from '../history/closed-position-snapshot-sync.ts';
import { SqliteMirrorWriter } from '../observability/sqlite-mirror-writer.ts';

const DEFAULT_DB_PATH = process.env.LIVE_DB_MIRROR_PATH ?? join(
  process.env.LIVE_STATE_DIR ?? 'state',
  'lightld-observability.sqlite'
);

function toUnixSeconds(value: string) {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
}

function pickClosestOhlcvClose(rows: Array<Record<string, unknown>>, targetTimestamp: number) {
  let bestClose = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    const timestamp = Number(row.timestamp ?? 0);
    const close = Number(row.close ?? 0);

    if (!Number.isFinite(timestamp) || !Number.isFinite(close) || close <= 0) {
      continue;
    }

    const distance = Math.abs(timestamp - targetTimestamp);
    if (distance < bestDistance) {
      bestClose = close;
      bestDistance = distance;
    }
  }

  return bestClose;
}

function looksLikeBase58Address(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function parsePoolAddressFromLifecycleKey(lifecycleKey: string, tokenMint: string) {
  const prefix = 'position:';
  if (!lifecycleKey.startsWith(prefix) || !lifecycleKey.endsWith(`:${tokenMint}`)) {
    return '';
  }

  return lifecycleKey.slice(prefix.length, -1 * (`:${tokenMint}`).length);
}

function readOrderSeedRows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });

  try {
    return db.prepare(`
      SELECT
        token_mint AS tokenMint,
        token_symbol AS tokenSymbol,
        pool_address AS poolAddress,
        COALESCE(NULLIF(chain_position_address, ''), NULLIF(position_id, ''), '') AS positionAddress,
        action,
        COALESCE(NULLIF(updated_at, ''), created_at) AS createdAt,
        COALESCE(NULLIF(confirmation_signature, ''), NULLIF(submission_id, ''), '') AS signature
      FROM orders
      WHERE action IN ('add-lp', 'withdraw-lp')
        AND token_mint <> ''
      UNION ALL
      SELECT
        f.token_mint AS tokenMint,
        f.token_symbol AS tokenSymbol,
        COALESCE(NULLIF((
          SELECT o.pool_address
          FROM orders o
          WHERE o.pool_address <> ''
            AND o.token_mint = f.token_mint
            AND (
              o.lifecycle_key = f.lifecycle_key
              OR (
                f.chain_position_address <> ''
                AND (
                  o.chain_position_address = f.chain_position_address
                  OR o.position_id = f.chain_position_address
                  OR o.lifecycle_key = 'chain-position:' || f.chain_position_address
                )
              )
              OR (
                f.position_id <> ''
                AND (
                  o.chain_position_address = f.position_id
                  OR o.position_id = f.position_id
                )
              )
            )
          ORDER BY o.updated_at DESC
          LIMIT 1
        ), ''), '') AS poolAddress,
        COALESCE(NULLIF(f.chain_position_address, ''), NULLIF(f.position_id, ''), '') AS positionAddress,
        f.side AS action,
        f.recorded_at AS createdAt,
        COALESCE(NULLIF(f.confirmation_signature, ''), NULLIF(f.submission_id, ''), '') AS signature
      FROM fills f
      WHERE f.side IN ('add-lp', 'withdraw-lp')
        AND f.token_mint <> ''
        AND f.has_fill_evidence = 1
      ORDER BY createdAt ASC
    `).all() as ClosedPositionOrderSeedRow[];
  } finally {
    db.close();
  }
}

function readTrustedFillRows(path: string): TrustedClosedPositionFillRow[] {
  const db = new DatabaseSync(path, { readOnly: true });

  try {
    const rows = db.prepare(`
      SELECT
        f.lifecycle_key AS lifecycleKey,
        f.token_mint AS tokenMint,
        f.token_symbol AS tokenSymbol,
        f.side AS side,
        f.recorded_at AS recordedAt,
        COALESCE(f.filled_sol, f.actual_filled_sol, f.amount, 0) AS filledSol,
        f.position_id AS positionId,
        f.chain_position_address AS chainPositionAddress,
        COALESCE(NULLIF((
          SELECT o.pool_address
          FROM orders o
          WHERE o.pool_address <> ''
            AND o.token_mint = f.token_mint
            AND (
              o.lifecycle_key = f.lifecycle_key
              OR (
                f.chain_position_address <> ''
                AND (
                  o.chain_position_address = f.chain_position_address
                  OR o.position_id = f.chain_position_address
                  OR o.lifecycle_key = 'chain-position:' || f.chain_position_address
                )
              )
              OR (
                f.position_id <> ''
                AND (
                  o.chain_position_address = f.position_id
                  OR o.position_id = f.position_id
                )
              )
            )
          ORDER BY o.updated_at DESC
          LIMIT 1
        ), ''), '') AS poolAddress
      FROM fills f
      WHERE f.side IN ('add-lp', 'withdraw-lp')
        AND f.token_mint <> ''
        AND f.has_fill_evidence = 1
        AND COALESCE(f.filled_sol, f.actual_filled_sol, f.amount, 0) > 0
      ORDER BY f.recorded_at ASC
    `).all() as Array<{
      lifecycleKey: string;
      tokenMint: string;
      tokenSymbol: string;
      side: 'add-lp' | 'withdraw-lp';
      recordedAt: string;
      filledSol: number;
      positionId: string;
      chainPositionAddress: string;
      poolAddress: string;
    }>;

    return rows.map((row) => ({
      tokenMint: row.tokenMint,
      tokenSymbol: row.tokenSymbol,
      poolAddress: row.poolAddress || parsePoolAddressFromLifecycleKey(row.lifecycleKey, row.tokenMint),
      positionAddress: looksLikeBase58Address(row.chainPositionAddress)
        ? row.chainPositionAddress
        : looksLikeBase58Address(row.positionId)
          ? row.positionId
          : '',
      side: row.side,
      recordedAt: row.recordedAt,
      filledSol: row.filledSol
    }));
  } finally {
    db.close();
  }
}

async function main() {
  const config = loadSolanaExecutionConfig();
  const keypair = await loadSolanaKeypair({
    keypairPath: config.keypairPath,
    expectedPublicKey: config.expectedPublicKey
  });
  const orderRows = readOrderSeedRows(DEFAULT_DB_PATH);
  const fillRows = readTrustedFillRows(DEFAULT_DB_PATH);
  const seeds = buildClosedPositionOrderSeeds(orderRows);

  if (seeds.length === 0) {
    process.stdout.write('No closed LP lifecycle seeds found in mirror orders.\n');
    return;
  }

  const writer = new SqliteMirrorWriter({ path: DEFAULT_DB_PATH });
  await writer.open();

  try {
    const rpcClient = new SolanaRpcClient({
      rpcUrl: config.rpcUrl,
      writeRpcUrls: config.writeRpcUrls,
      readRpcUrls: config.readRpcUrls
    });
    const chainSnapshots = await syncClosedPositionSnapshots({
      walletAddress: keypair.publicKey.toBase58(),
      seeds,
      rpcClient,
      loadTokenPriceInSol: async (seed) => {
        const target = toUnixSeconds(seed.closedAt);
        if (target <= 0 || seed.poolAddress.length === 0) {
          return 0;
        }

        try {
          const response = await fetchMeteoraOhlcv(seed.poolAddress, {
            timeframe: '5m',
            startTime: target - 900,
            endTime: target + 900
          });
          return pickClosestOhlcvClose(response.data ?? [], target);
        } catch {
          return 0;
        }
      },
      writer
    });
    const fillSnapshots = buildClosedPositionSnapshotsFromTrustedFills({
      walletAddress: keypair.publicKey.toBase58(),
      fills: fillRows
    });
    if (fillSnapshots.length > 0) {
      await writer.writeClosedPositionSnapshots(fillSnapshots);
    }

    process.stdout.write(
      `Synced ${chainSnapshots.length} chain and ${fillSnapshots.length} fill closed position snapshots for ${keypair.publicKey.toBase58()}.\n`
    );
  } finally {
    await writer.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
