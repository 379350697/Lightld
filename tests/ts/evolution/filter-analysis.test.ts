import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appendJsonLine } from '../../../src/journals/jsonl-writer';
import { SqliteMirrorWriter } from '../../../src/observability/sqlite-mirror-writer';
import {
  analyzeFilterEvidence,
  loadEvolutionEvidence,
  resolveEvolutionPaths,
  type CandidateScanRecord,
  type WatchlistSnapshotRecord
} from '../../../src/evolution';

describe('loadEvolutionEvidence', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('falls back to JSONL artifacts when the SQLite mirror is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-evolution-loader-jsonl-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));

    await appendJsonLine(paths.candidateScansPath, buildCandidateScan({
      scanId: 'scan-jsonl',
      selectedTokenMint: 'mint-selected'
    }));
    await appendJsonLine(paths.watchlistSnapshotsPath, buildWatchlistSnapshot({
      watchId: 'watch-jsonl',
      tokenMint: 'mint-selected',
      sourceReason: 'selected',
      currentValueSol: 0.2
    }));
    await appendJsonLine(paths.positionOutcomesPath, buildOutcome({
      cycleId: 'cycle-jsonl',
      tokenMint: 'mint-selected',
      actualExitReason: 'take-profit-hit'
    }));

    const evidence = await loadEvolutionEvidence({
      strategyId: 'new-token-v1',
      stateRootDir
    });

    expect(evidence.candidateScans).toHaveLength(1);
    expect(evidence.watchlistSnapshots).toHaveLength(1);
    expect(evidence.outcomes).toHaveLength(1);
  });

  it('loads candidate scans and watchlist snapshots from SQLite mirror when available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-evolution-loader-mirror-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const mirrorPath = join(root, 'mirror.sqlite');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));
    const writer = new SqliteMirrorWriter({ path: mirrorPath });

    await writer.open();
    await writer.writeBatch([
      {
        type: 'candidate_scan',
        priority: 'low',
        payload: buildCandidateScan({
          scanId: 'scan-mirror',
          selectedTokenMint: 'mint-mirror'
        })
      },
      {
        type: 'watchlist_snapshot',
        priority: 'low',
        payload: buildWatchlistSnapshot({
          watchId: 'watch-mirror',
          tokenMint: 'mint-mirror',
          sourceReason: 'selected',
          currentValueSol: 0.3
        })
      }
    ]);
    await writer.close();
    await appendJsonLine(paths.positionOutcomesPath, buildOutcome({
      cycleId: 'cycle-mirror',
      tokenMint: 'mint-mirror',
      actualExitReason: 'take-profit-hit'
    }));

    const evidence = await loadEvolutionEvidence({
      strategyId: 'new-token-v1',
      stateRootDir,
      mirrorPath
    });

    expect(evidence.candidateScans).toEqual([
      expect.objectContaining({ scanId: 'scan-mirror', selectedTokenMint: 'mint-mirror' })
    ]);
    expect(evidence.watchlistSnapshots).toEqual([
      expect.objectContaining({ watchId: 'watch-mirror', tokenMint: 'mint-mirror' })
    ]);
    expect(evidence.outcomes).toEqual([
      expect.objectContaining({ cycleId: 'cycle-mirror', tokenMint: 'mint-mirror' })
    ]);
  });
});

describe('analyzeFilterEvidence', () => {
  it('surfaces blocked-reason concentration and missed opportunities for filter parameters', () => {
    const result = analyzeFilterEvidence({
      candidateScans: [
        buildCandidateScan({
          scanId: 'scan-1',
          blockedReason: 'min-liquidity',
          selectedTokenMint: 'mint-selected',
          candidates: [
            buildCandidateSample({
              sampleId: 'cand-selected',
              tokenMint: 'mint-selected',
              tokenSymbol: 'SAFE',
              poolAddress: 'pool-selected',
              selected: true,
              selectionRank: 1,
              blockedReason: '',
              rejectionStage: 'none'
            }),
            buildCandidateSample({
              sampleId: 'cand-liquidity',
              tokenMint: 'mint-breakout',
              tokenSymbol: 'BRK',
              poolAddress: 'pool-breakout',
              selected: false,
              selectionRank: 2,
              blockedReason: 'min-liquidity',
              rejectionStage: 'selection'
            }),
            buildCandidateSample({
              sampleId: 'cand-bin',
              tokenMint: 'mint-bin',
              tokenSymbol: 'BIN',
              poolAddress: 'pool-bin',
              selected: false,
              selectionRank: 3,
              blockedReason: 'min-bin-step',
              rejectionStage: 'lp_eligibility'
            }),
            buildCandidateSample({
              sampleId: 'cand-volume',
              tokenMint: 'mint-volume',
              tokenSymbol: 'VOL',
              poolAddress: 'pool-volume',
              selected: false,
              selectionRank: 4,
              blockedReason: 'min-volume-24h',
              rejectionStage: 'lp_eligibility'
            }),
            buildCandidateSample({
              sampleId: 'cand-fee',
              tokenMint: 'mint-fee',
              tokenSymbol: 'FEE',
              poolAddress: 'pool-fee',
              selected: false,
              selectionRank: 5,
              blockedReason: 'min-fee-tvl-ratio-24h',
              rejectionStage: 'lp_eligibility'
            })
          ]
        })
      ],
      watchlistSnapshots: [
        buildWatchlistSnapshot({
          watchId: 'watch-selected',
          tokenMint: 'mint-selected',
          sourceReason: 'selected',
          currentValueSol: 0.18
        }),
        buildWatchlistSnapshot({
          watchId: 'watch-breakout',
          tokenMint: 'mint-breakout',
          sourceReason: 'filtered_out',
          currentValueSol: 0.62
        }),
        buildWatchlistSnapshot({
          watchId: 'watch-bin',
          tokenMint: 'mint-bin',
          sourceReason: 'filtered_out',
          currentValueSol: 0.55
        }),
        buildWatchlistSnapshot({
          watchId: 'watch-volume',
          tokenMint: 'mint-volume',
          sourceReason: 'filtered_out',
          currentValueSol: 0.51
        }),
        buildWatchlistSnapshot({
          watchId: 'watch-fee',
          tokenMint: 'mint-fee',
          sourceReason: 'filtered_out',
          currentValueSol: 0.49
        })
      ],
      minimumSampleSize: 1
    });

    expect(result.summary.missedOpportunityCount).toBe(4);
    expect(result.summary.blockedReasonCounts[0]).toEqual({
      reason: 'min-liquidity',
      count: 1
    });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'filters.minLiquidityUsd',
        direction: 'decrease'
      }),
      expect.objectContaining({
        path: 'lpConfig.minBinStep',
        direction: 'decrease'
      }),
      expect.objectContaining({
        path: 'lpConfig.minVolume24hUsd',
        direction: 'decrease'
      }),
      expect.objectContaining({
        path: 'lpConfig.minFeeTvlRatio24h',
        direction: 'decrease'
      })
    ]));
    expect(result.noActionReasons).toEqual([]);
  });

  it('returns a no-action result when the filter sample size is too small', () => {
    const result = analyzeFilterEvidence({
      candidateScans: [],
      watchlistSnapshots: [],
      minimumSampleSize: 2
    });

    expect(result.findings).toEqual([]);
    expect(result.noActionReasons).toContain('insufficient_sample_size');
  });
});

function buildCandidateScan(overrides: Partial<CandidateScanRecord>): CandidateScanRecord {
  return {
    scanId: 'scan-1',
    capturedAt: '2026-04-18T00:00:00.000Z',
    strategyId: 'new-token-v1',
    poolCount: 3,
    prefilteredCount: 3,
    postLpCount: 2,
    postSafetyCount: 2,
    eligibleSelectionCount: 1,
    scanWindowOpen: true,
    activePositionsCount: 0,
    selectedTokenMint: 'mint-selected',
    selectedPoolAddress: 'pool-selected',
    blockedReason: '',
    candidates: [
      buildCandidateSample({
        sampleId: 'cand-1',
        tokenMint: 'mint-selected',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-selected',
        selected: true,
        selectionRank: 1,
        blockedReason: '',
        rejectionStage: 'none'
      })
    ],
    ...overrides
  };
}

function buildCandidateSample(overrides: Partial<CandidateScanRecord['candidates'][number]>): CandidateScanRecord['candidates'][number] {
  return {
    sampleId: 'cand-1',
    capturedAt: '2026-04-18T00:00:00.000Z',
    strategyId: 'new-token-v1',
    cycleId: 'cycle-1',
    tokenMint: 'mint-selected',
    tokenSymbol: 'SAFE',
    poolAddress: 'pool-selected',
    liquidityUsd: 10000,
    holders: 120,
    safetyScore: 80,
    volume24h: 5000,
    feeTvlRatio24h: 0.12,
    binStep: 120,
    hasInventory: false,
    hasLpPosition: false,
    selected: true,
    selectionRank: 1,
    blockedReason: '',
    rejectionStage: 'none',
    runtimeMode: 'healthy',
    sessionPhase: 'active',
    ...overrides
  };
}

function buildWatchlistSnapshot(overrides: Partial<WatchlistSnapshotRecord>): WatchlistSnapshotRecord {
  return {
    watchId: 'watch-1',
    trackedSince: '2026-04-18T00:00:00.000Z',
    strategyId: 'new-token-v1',
    tokenMint: 'mint-selected',
    tokenSymbol: 'SAFE',
    poolAddress: 'pool-selected',
    observationAt: '2026-04-18T01:00:00.000Z',
    windowLabel: '1h',
    currentValueSol: 0.2,
    liquidityUsd: 10000,
    activeBinId: null,
    lowerBinId: null,
    upperBinId: null,
    binCount: null,
    fundedBinCount: null,
    solDepletedBins: null,
    unclaimedFeeSol: null,
    hasInventory: true,
    hasLpPosition: false,
    sourceReason: 'selected',
    ...overrides
  };
}

function buildOutcome(overrides: Record<string, unknown>) {
  return {
    cycleId: 'cycle-1',
    strategyId: 'new-token-v1',
    recordedAt: '2026-04-18T00:30:00.000Z',
    tokenMint: 'mint-selected',
    tokenSymbol: 'SAFE',
    poolAddress: 'pool-selected',
    runtimeMode: 'healthy',
    sessionPhase: 'active',
    action: 'dca-out',
    actualExitReason: 'take-profit-hit',
    liveOrderSubmitted: true,
    parameterSnapshot: {
      takeProfitPct: 20,
      stopLossPct: 12,
      lpEnabled: true,
      lpStopLossNetPnlPct: 20,
      lpTakeProfitNetPnlPct: 30,
      lpSolDepletionExitBins: 60,
      lpMinBinStep: 100,
      lpMinVolume24hUsd: 100000,
      lpMinFeeTvlRatio24h: 0,
      maxHoldHours: 10
    },
    exitMetrics: {
      requestedPositionSol: 0.15,
      quoteOutputSol: 0.2
    },
    ...overrides
  };
}
