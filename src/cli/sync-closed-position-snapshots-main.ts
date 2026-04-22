import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadSolanaExecutionConfig } from '../execution/solana/solana-execution-config.ts';
import { SolanaRpcClient } from '../execution/solana/solana-rpc-client.ts';
import { loadSolanaKeypair } from '../execution/solana/solana-transaction-signer.ts';
import { fetchMeteoraOhlcv } from '../ingest/meteora/client.ts';
import {
  buildClosedPositionOrderSeeds,
  syncClosedPositionSnapshots,
  type ClosedPositionOrderSeedRow
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
        AND COALESCE(NULLIF(confirmation_signature, ''), NULLIF(submission_id, ''), '') <> ''
      ORDER BY created_at ASC
    `).all() as ClosedPositionOrderSeedRow[];
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
    const snapshots = await syncClosedPositionSnapshots({
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

    process.stdout.write(`Synced ${snapshots.length} closed position snapshots for ${keypair.publicKey.toBase58()}.\n`);
  } finally {
    await writer.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
