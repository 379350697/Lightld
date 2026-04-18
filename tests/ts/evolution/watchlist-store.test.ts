import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  WatchlistStore,
  type TrackedWatchTokenRecord,
  type WatchlistSnapshotRecord
} from '../../../src/evolution';

describe('WatchlistStore', () => {
  it('returns empty tracked tokens and snapshots when no files exist yet', async () => {
    const trackedTokensPath = 'tmp/evolution/test-watchlist-tracked-tokens-empty.json';
    const snapshotsPath = 'tmp/evolution/test-watchlist-snapshots-empty.jsonl';
    await rm(trackedTokensPath, { force: true });
    await rm(snapshotsPath, { force: true });

    const store = new WatchlistStore({
      trackedTokensPath,
      snapshotsPath
    });

    await expect(store.readTrackedTokens()).resolves.toEqual([]);
    await expect(store.readSnapshots()).resolves.toEqual([]);
  });

  it('writes tracked tokens and appends snapshots', async () => {
    const trackedTokensPath = 'tmp/evolution/test-watchlist-tracked-tokens.json';
    const snapshotsPath = 'tmp/evolution/test-watchlist-snapshots.jsonl';
    await rm(trackedTokensPath, { force: true });
    await rm(snapshotsPath, { force: true });

    const store = new WatchlistStore({
      trackedTokensPath,
      snapshotsPath
    });

    const trackedTokens: TrackedWatchTokenRecord[] = [
      {
        watchId: 'watch-1',
        trackedSince: '2026-04-18T00:00:00.000Z',
        strategyId: 'new-token-v1',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-safe',
        sourceReason: 'selected',
        firstCapturedAt: '2026-04-18T00:00:00.000Z',
        lastEvaluatedAt: '2026-04-18T00:15:00.000Z'
      }
    ];
    const snapshot: WatchlistSnapshotRecord = {
      watchId: 'watch-1',
      trackedSince: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      poolAddress: 'pool-safe',
      observationAt: '2026-04-18T01:00:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.42,
      liquidityUsd: 18_500,
      activeBinId: 505,
      lowerBinId: 480,
      upperBinId: 520,
      binCount: 41,
      fundedBinCount: 19,
      solDepletedBins: 8,
      unclaimedFeeSol: 0.015,
      hasInventory: true,
      hasLpPosition: true,
      sourceReason: 'selected'
    };

    await store.writeTrackedTokens(trackedTokens);
    await store.appendSnapshot(snapshot);

    await expect(store.readTrackedTokens()).resolves.toEqual(trackedTokens);
    await expect(store.readSnapshots()).resolves.toEqual([snapshot]);
  });
});
