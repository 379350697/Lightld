import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildStatusView,
  readMirrorResearch
} from '../../../src/observability/mirror-query-service';
import { SqliteMirrorWriter } from '../../../src/observability/sqlite-mirror-writer';

describe('buildStatusView', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('falls back to file-backed state when the mirror is unavailable', async () => {
    const result = await buildStatusView({
      mirrorQuery: async () => {
        throw new Error('mirror unavailable');
      },
      fileState: async () => ({
        mode: 'healthy',
        pendingSubmission: false,
        allowNewOpens: true,
        flattenOnly: false,
        circuitReason: '',
        lastSuccessfulTickAt: '2026-03-22T00:00:00.000Z',
        dependencyHealth: {
          quoteFailures: 0,
          reconcileFailures: 0
        },
        updatedAt: '2026-03-22T00:00:00.000Z'
      })
    });

    expect(result.mode).toBe('healthy');
    expect(result.pendingSubmission).toBe(false);
  });

  it('reads recent mirrored evolution research rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-query-evolution-'));
    directories.push(root);
    const path = join(root, 'mirror.sqlite');
    const writer = new SqliteMirrorWriter({ path });

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
          candidates: []
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
    await writer.close();

    const result = await readMirrorResearch(path);

    expect(result.recentCandidateScans).toEqual([
      expect.objectContaining({
        scanId: 'scan-1',
        selectedTokenMint: 'mint-safe'
      })
    ]);
    expect(result.recentWatchlistSnapshots).toEqual([
      expect.objectContaining({
        watchId: 'new-token-v1:mint-safe:pool-safe',
        tokenMint: 'mint-safe',
        windowLabel: '1h'
      })
    ]);
  });
});
