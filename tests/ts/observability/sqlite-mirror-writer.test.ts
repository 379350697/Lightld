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
