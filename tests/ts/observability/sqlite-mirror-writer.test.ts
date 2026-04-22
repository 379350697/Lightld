import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteMirrorWriter } from '../../../src/observability/sqlite-mirror-writer';

describe('SqliteMirrorWriter', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('initializes schema and writes a batch of mirror events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-'));
    directories.push(root);
    const writer = new SqliteMirrorWriter({ path: join(root, 'mirror.sqlite') });

    await writer.open();
    await writer.writeBatch([
      {
        type: 'runtime_snapshot',
        priority: 'high',
        payload: {
          snapshotAt: '2026-03-22T00:00:00.000Z',
          runtimeMode: 'healthy',
          allowNewOpens: true,
          flattenOnly: false,
          pendingSubmission: false,
          circuitReason: '',
          quoteFailures: 0,
          reconcileFailures: 0,
          walletSol: 1.25,
          lpValueSol: 0.9,
          unclaimedFeeSol: 0.07,
          netWorthSol: 2.22,
          openPositionCount: 1
        }
      }
    ]);

    await expect(writer.countRows('runtime_snapshots')).resolves.toBe(1);
    await writer.close();

    const db = new DatabaseSync(join(root, 'mirror.sqlite'), { readOnly: true });
    const snapshot = db.prepare(`
      SELECT wallet_sol, lp_value_sol, unclaimed_fee_sol, net_worth_sol, open_position_count
      FROM runtime_snapshots
      LIMIT 1
    `).get() as {
      wallet_sol: number;
      lp_value_sol: number;
      unclaimed_fee_sol: number;
      net_worth_sol: number;
      open_position_count: number;
    };
    db.close();
    expect(snapshot).toEqual({
      wallet_sol: 1.25,
      lp_value_sol: 0.9,
      unclaimed_fee_sol: 0.07,
      net_worth_sol: 2.22,
      open_position_count: 1
    });
  });

  it('creates time-ordering indexes used by dashboard polling queries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-indexes-'));
    directories.push(root);
    const path = join(root, 'mirror.sqlite');
    const writer = new SqliteMirrorWriter({ path });

    await writer.open();
    await writer.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const indexes = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    db.close();

    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
      'idx_candidate_scans_captured_at',
      'idx_watchlist_snapshots_observation_at',
      'idx_orders_submission_id',
      'idx_orders_updated_at',
      'idx_fills_recorded_at',
      'idx_reconciliations_recorded_at',
      'idx_incidents_recorded_at'
    ]));
  });

  it('migrates existing runtime snapshot tables to include equity columns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-migrate-'));
    directories.push(root);
    const path = join(root, 'mirror.sqlite');
    const bootstrap = new DatabaseSync(path);

    bootstrap.exec(`
      CREATE TABLE runtime_snapshots (
        snapshot_at TEXT PRIMARY KEY,
        runtime_mode TEXT NOT NULL,
        allow_new_opens INTEGER NOT NULL,
        flatten_only INTEGER NOT NULL,
        pending_submission INTEGER NOT NULL,
        circuit_reason TEXT NOT NULL,
        quote_failures INTEGER NOT NULL,
        reconcile_failures INTEGER NOT NULL
      )
    `);
    bootstrap.close();

    const writer = new SqliteMirrorWriter({ path });
    await writer.open();
    await writer.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const columns = db.prepare('PRAGMA table_info(runtime_snapshots)').all() as Array<{ name: string }>;
    db.close();

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'wallet_sol',
      'lp_value_sol',
      'unclaimed_fee_sol',
      'net_worth_sol',
      'open_position_count'
    ]));
  });

  it('migrates orders and fills tables to include reconciliation identity columns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-identity-migrate-'));
    directories.push(root);
    const path = join(root, 'mirror.sqlite');
    const bootstrap = new DatabaseSync(path);

    bootstrap.exec(`
      CREATE TABLE orders (
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
      CREATE TABLE fills (
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
    bootstrap.close();

    const writer = new SqliteMirrorWriter({ path });
    await writer.open();
    await writer.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const orderColumns = db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>;
    const fillColumns = db.prepare('PRAGMA table_info(fills)').all() as Array<{ name: string }>;
    db.close();

    expect(orderColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'open_intent_id',
      'position_id',
      'chain_position_address'
    ]));
    expect(fillColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'open_intent_id',
      'position_id',
      'chain_position_address'
    ]));
  });

  it('persists reconciliation identity columns for orders and fills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-identity-write-'));
    directories.push(root);
    const path = join(root, 'mirror.sqlite');
    const writer = new SqliteMirrorWriter({ path });

    await writer.open();
    await writer.writeBatch([
      {
        type: 'order',
        priority: 'high',
        payload: {
          idempotencyKey: 'order-1',
          cycleId: 'cycle-1',
          strategyId: 'new-token-v1',
          submissionId: 'sub-1',
          openIntentId: 'intent-1',
          positionId: 'position-1',
          chainPositionAddress: 'chain-pos-1',
          confirmationSignature: 'sig-1',
          poolAddress: 'pool-1',
          tokenMint: 'mint-1',
          tokenSymbol: 'SAFE',
          action: 'add-lp',
          requestedPositionSol: 0.5,
          quotedOutputSol: 0.48,
          broadcastStatus: 'submitted',
          confirmationStatus: 'submitted',
          finality: 'unknown',
          createdAt: '2026-04-18T08:00:00.000Z',
          updatedAt: '2026-04-18T08:00:01.000Z'
        }
      },
      {
        type: 'fill',
        priority: 'high',
        payload: {
          fillId: 'fill-1',
          submissionId: 'sub-1',
          openIntentId: 'intent-1',
          positionId: 'position-1',
          chainPositionAddress: 'chain-pos-1',
          confirmationSignature: 'sig-1',
          cycleId: 'cycle-1',
          tokenMint: 'mint-1',
          tokenSymbol: 'SAFE',
          side: 'buy',
          amount: 0.5,
          filledSol: 0.5,
          recordedAt: '2026-04-18T08:00:02.000Z'
        }
      }
    ]);
    await writer.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const order = db.prepare(`
      SELECT open_intent_id, position_id, chain_position_address
      FROM orders
      WHERE idempotency_key = 'order-1'
    `).get() as {
      open_intent_id: string;
      position_id: string;
      chain_position_address: string;
    };
    const fill = db.prepare(`
      SELECT open_intent_id, position_id, chain_position_address
      FROM fills
      WHERE fill_id = 'fill-1'
    `).get() as {
      open_intent_id: string;
      position_id: string;
      chain_position_address: string;
    };
    db.close();

    expect(order).toEqual({
      open_intent_id: 'intent-1',
      position_id: 'position-1',
      chain_position_address: 'chain-pos-1'
    });
    expect(fill).toEqual({
      open_intent_id: 'intent-1',
      position_id: 'position-1',
      chain_position_address: 'chain-pos-1'
    });
  });

  it('writes and queries mirrored evolution research rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-evolution-'));
    directories.push(root);
    const writer = new SqliteMirrorWriter({ path: join(root, 'mirror.sqlite') });

    await writer.open();
    await writer.writeBatch([
      {
        type: 'candidate_scan',
        priority: 'low',
        payload: {
          scanId: 'scan-1',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          poolCount: 3,
          prefilteredCount: 2,
          postLpCount: 2,
          postSafetyCount: 1,
          eligibleSelectionCount: 1,
          scanWindowOpen: true,
          activePositionsCount: 0,
          selectedTokenMint: 'mint-safe',
          selectedPoolAddress: 'pool-safe',
          blockedReason: '',
          candidates: [
            {
              sampleId: 'cand-1',
              capturedAt: '2026-04-18T00:00:00.000Z',
              strategyId: 'new-token-v1',
              cycleId: 'cycle-1',
              tokenMint: 'mint-safe',
              tokenSymbol: 'SAFE',
              poolAddress: 'pool-safe',
              liquidityUsd: 10000,
              holders: 120,
              safetyScore: 80,
              volume24h: 5000,
              feeTvlRatio24h: 0.12,
              binStep: 20,
              hasInventory: false,
              hasLpPosition: false,
              selected: true,
              selectionRank: 1,
              blockedReason: '',
              rejectionStage: 'none',
              runtimeMode: 'healthy',
              sessionPhase: 'active'
            }
          ]
        }
      },
      {
        type: 'watchlist_snapshot',
        priority: 'low',
        payload: {
          watchId: 'new-token-v1:mint-safe:pool-safe',
          trackedSince: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          tokenMint: 'mint-safe',
          tokenSymbol: 'SAFE',
          poolAddress: 'pool-safe',
          observationAt: '2026-04-18T01:00:00.000Z',
          windowLabel: '1h',
          currentValueSol: 0.4,
          liquidityUsd: 12000,
          activeBinId: 123,
          lowerBinId: 100,
          upperBinId: 140,
          binCount: 41,
          fundedBinCount: 20,
          solDepletedBins: 5,
          unclaimedFeeSol: 0.02,
          hasInventory: true,
          hasLpPosition: true,
          sourceReason: 'selected'
        }
      }
    ]);

    await expect(writer.countRows('candidate_scans')).resolves.toBe(1);
    await expect(writer.countRows('watchlist_snapshots')).resolves.toBe(1);
    await expect(writer.readRecentCandidateScans(5)).resolves.toEqual([
      expect.objectContaining({
        scanId: 'scan-1',
        selectedTokenMint: 'mint-safe',
        selectedPoolAddress: 'pool-safe',
        candidateCount: 1
      })
    ]);
    await expect(writer.readRecentWatchlistSnapshots(5)).resolves.toEqual([
      expect.objectContaining({
        watchId: 'new-token-v1:mint-safe:pool-safe',
        windowLabel: '1h',
        tokenMint: 'mint-safe',
        hasLpPosition: true
      })
    ]);

    await writer.close();
  });
});
