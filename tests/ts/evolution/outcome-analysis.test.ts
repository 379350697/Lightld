import { describe, expect, it } from 'vitest';

import {
  analyzeOutcomeEvidence,
  type LiveCycleOutcomeRecord,
  type WatchlistSnapshotRecord
} from '../../../src/evolution';

describe('analyzeOutcomeEvidence', () => {
  it('surfaces TP/SL and LP/bin directional findings from follow-through evidence', () => {
    const result = analyzeOutcomeEvidence({
      outcomes: [
        buildOutcome({
          cycleId: 'cycle-tp',
          tokenMint: 'mint-tp',
          tokenSymbol: 'TP',
          actualExitReason: 'take-profit-hit',
          action: 'dca-out',
          exitMetrics: {
            requestedPositionSol: 0.15,
            quoteOutputSol: 0.2
          }
        }),
        buildOutcome({
          cycleId: 'cycle-sl',
          tokenMint: 'mint-sl',
          tokenSymbol: 'SL',
          actualExitReason: 'stop-loss-hit',
          action: 'dca-out',
          exitMetrics: {
            requestedPositionSol: 0.15,
            quoteOutputSol: 0.16
          }
        }),
        buildOutcome({
          cycleId: 'cycle-lp',
          tokenMint: 'mint-lp',
          tokenSymbol: 'LP',
          actualExitReason: 'sol-depletion-hit',
          action: 'withdraw-lp',
          exitMetrics: {
            requestedPositionSol: 0.15,
            lpCurrentValueSol: 0.4,
            lpSolDepletedBins: 60,
            lpUnclaimedFeeSol: 0.02
          }
        }),
        buildOutcome({
          cycleId: 'cycle-lp-stop',
          tokenMint: 'mint-lp-stop',
          tokenSymbol: 'LPS',
          actualExitReason: 'lp-stop-loss',
          action: 'withdraw-lp',
          actualExitMetricValue: -24,
          exitMetrics: {
            requestedPositionSol: 0.15,
            lpCurrentValueSol: 0.08,
            lpNetPnlPct: -24,
            lpUnclaimedFeeSol: 0.01
          }
        }),
        buildOutcome({
          cycleId: 'cycle-lp-tp',
          tokenMint: 'mint-lp-tp',
          tokenSymbol: 'LPT',
          actualExitReason: 'lp-take-profit',
          action: 'withdraw-lp',
          actualExitMetricValue: 32,
          exitMetrics: {
            requestedPositionSol: 0.15,
            lpCurrentValueSol: 0.23,
            lpNetPnlPct: 32,
            lpUnclaimedFeeSol: 0.01
          }
        })
      ],
      watchlistSnapshots: [
        buildWatchlistSnapshot({
          watchId: 'watch-tp',
          tokenMint: 'mint-tp',
          tokenSymbol: 'TP',
          currentValueSol: 0.34,
          sourceReason: 'selected'
        }),
        buildWatchlistSnapshot({
          watchId: 'watch-sl',
          tokenMint: 'mint-sl',
          tokenSymbol: 'SL',
          currentValueSol: 0.08,
          sourceReason: 'selected'
        }),
        buildWatchlistSnapshot({
          watchId: 'watch-lp',
          tokenMint: 'mint-lp',
          tokenSymbol: 'LP',
          currentValueSol: 0.58,
          hasLpPosition: true,
          solDepletedBins: 72,
          unclaimedFeeSol: 0.04,
          sourceReason: 'selected'
        }),
        buildWatchlistSnapshot({
          watchId: 'watch-lp-stop',
          tokenMint: 'mint-lp-stop',
          tokenSymbol: 'LPS',
          currentValueSol: 0.04,
          hasLpPosition: true,
          sourceReason: 'selected'
        }),
        buildWatchlistSnapshot({
          watchId: 'watch-lp-tp',
          tokenMint: 'mint-lp-tp',
          tokenSymbol: 'LPT',
          currentValueSol: 0.33,
          hasLpPosition: true,
          sourceReason: 'selected'
        })
      ],
      minimumSampleSize: 1
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'riskThresholds.takeProfitPct',
        direction: 'increase'
      }),
      expect.objectContaining({
        path: 'riskThresholds.stopLossPct',
        direction: 'decrease'
      }),
      expect.objectContaining({
        path: 'lpConfig.solDepletionExitBins',
        direction: 'increase'
      }),
      expect.objectContaining({
        path: 'lpConfig.stopLossNetPnlPct',
        direction: 'decrease'
      }),
      expect.objectContaining({
        path: 'lpConfig.takeProfitNetPnlPct',
        direction: 'increase'
      })
    ]));
    expect(result.noActionReasons).toEqual([]);
  });

  it('returns a no-action result when outcome samples are below threshold', () => {
    const result = analyzeOutcomeEvidence({
      outcomes: [
        buildOutcome({
          cycleId: 'cycle-only',
          tokenMint: 'mint-only',
          tokenSymbol: 'ONLY'
        })
      ],
      watchlistSnapshots: [],
      minimumSampleSize: 2
    });

    expect(result.findings).toEqual([]);
    expect(result.noActionReasons).toContain('insufficient_sample_size');
  });
});

function buildOutcome(overrides: Partial<LiveCycleOutcomeRecord>): LiveCycleOutcomeRecord {
  return {
    cycleId: 'cycle-1',
    strategyId: 'new-token-v1',
    recordedAt: '2026-04-18T00:30:00.000Z',
    tokenMint: 'mint-selected',
    tokenSymbol: 'SAFE',
    poolAddress: 'pool-selected',
    runtimeMode: 'healthy',
    sessionPhase: 'active',
    positionId: 'position-1',
    action: 'dca-out',
    actualExitReason: 'take-profit-hit',
    openedAt: '2026-04-18T00:00:00.000Z',
    closedAt: '2026-04-18T00:30:00.000Z',
    entrySol: 0.15,
    maxObservedUpsidePct: 33.33,
    maxObservedDrawdownPct: 0,
    actualExitMetricValue: 0.2,
    takeProfitPctAtEntry: 20,
    stopLossPctAtEntry: 12,
    lpStopLossNetPnlPctAtEntry: 20,
    lpTakeProfitNetPnlPctAtEntry: 30,
    solDepletionExitBinsAtEntry: 60,
    minBinStepAtEntry: 100,
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
    currentValueSol: 0.25,
    liquidityUsd: 12000,
    activeBinId: 123,
    lowerBinId: 100,
    upperBinId: 140,
    binCount: 41,
    fundedBinCount: 20,
    solDepletedBins: 60,
    unclaimedFeeSol: 0.02,
    hasInventory: true,
    hasLpPosition: false,
    sourceReason: 'selected',
    ...overrides
  };
}
