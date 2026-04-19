import { describe, expect, it } from 'vitest';

import {
  buildPoolDecisionSamples,
  type CandidateScanRecord,
  type LiveCycleOutcomeRecord,
  type WatchlistSnapshotRecord
} from '../../../src/evolution';

describe('buildPoolDecisionSamples', () => {
  it('derives future-path and baseline-relative counterfactual fields from existing evidence', () => {
    const candidateScans: CandidateScanRecord[] = [
      {
        scanId: 'scan-1',
        capturedAt: '2026-04-18T00:00:00.000Z',
        strategyId: 'new-token-v1',
        poolCount: 2,
        prefilteredCount: 2,
        postLpCount: 2,
        postSafetyCount: 2,
        eligibleSelectionCount: 1,
        scanWindowOpen: true,
        activePositionsCount: 0,
        selectedTokenMint: 'mint-selected',
        selectedPoolAddress: 'pool-selected',
        blockedReason: '',
        candidates: [
          {
            sampleId: 'cand-selected',
            capturedAt: '2026-04-18T00:00:00.000Z',
            strategyId: 'new-token-v1',
            cycleId: 'cycle-1',
            tokenMint: 'mint-selected',
            tokenSymbol: 'SEL',
            poolAddress: 'pool-selected',
            liquidityUsd: 12000,
            holders: 140,
            safetyScore: 91,
            volume24h: 50000,
            feeTvlRatio24h: 0.08,
            binStep: 120,
            hasInventory: false,
            hasLpPosition: false,
            selected: true,
            selectionRank: 1,
            blockedReason: '',
            rejectionStage: 'none',
            runtimeMode: 'healthy',
            sessionPhase: 'active'
          },
          {
            sampleId: 'cand-filtered',
            capturedAt: '2026-04-18T00:00:00.000Z',
            strategyId: 'new-token-v1',
            cycleId: 'cycle-1',
            tokenMint: 'mint-filtered',
            tokenSymbol: 'FIL',
            poolAddress: 'pool-filtered',
            liquidityUsd: 900,
            holders: 80,
            safetyScore: 77,
            volume24h: 12000,
            feeTvlRatio24h: 0.16,
            binStep: 100,
            hasInventory: false,
            hasLpPosition: false,
            selected: false,
            selectionRank: 2,
            blockedReason: 'min-liquidity',
            rejectionStage: 'selection',
            runtimeMode: 'healthy',
            sessionPhase: 'active'
          }
        ]
      }
    ];
    const watchlistSnapshots: WatchlistSnapshotRecord[] = [
      {
        watchId: 'watch-selected-1h',
        trackedSince: '2026-04-18T00:00:00.000Z',
        strategyId: 'new-token-v1',
        tokenMint: 'mint-selected',
        tokenSymbol: 'SEL',
        poolAddress: 'pool-selected',
        observationAt: '2026-04-18T01:00:00.000Z',
        windowLabel: '1h',
        currentValueSol: 0.4,
        liquidityUsd: 15000,
        activeBinId: null,
        lowerBinId: null,
        upperBinId: null,
        binCount: null,
        fundedBinCount: null,
        solDepletedBins: null,
        unclaimedFeeSol: null,
        hasInventory: true,
        hasLpPosition: false,
        sourceReason: 'selected'
      },
      {
        watchId: 'watch-filtered-1h',
        trackedSince: '2026-04-18T00:00:00.000Z',
        strategyId: 'new-token-v1',
        tokenMint: 'mint-filtered',
        tokenSymbol: 'FIL',
        poolAddress: 'pool-filtered',
        observationAt: '2026-04-18T01:00:00.000Z',
        windowLabel: '1h',
        currentValueSol: 0.75,
        liquidityUsd: 18000,
        activeBinId: null,
        lowerBinId: null,
        upperBinId: null,
        binCount: null,
        fundedBinCount: null,
        solDepletedBins: null,
        unclaimedFeeSol: null,
        hasInventory: false,
        hasLpPosition: false,
        sourceReason: 'filtered_out'
      },
      {
        watchId: 'watch-filtered-4h',
        trackedSince: '2026-04-18T00:00:00.000Z',
        strategyId: 'new-token-v1',
        tokenMint: 'mint-filtered',
        tokenSymbol: 'FIL',
        poolAddress: 'pool-filtered',
        observationAt: '2026-04-18T04:00:00.000Z',
        windowLabel: '4h',
        currentValueSol: 0.55,
        liquidityUsd: 14000,
        activeBinId: null,
        lowerBinId: null,
        upperBinId: null,
        binCount: null,
        fundedBinCount: null,
        solDepletedBins: null,
        unclaimedFeeSol: null,
        hasInventory: false,
        hasLpPosition: false,
        sourceReason: 'filtered_out'
      }
    ];
    const outcomes: LiveCycleOutcomeRecord[] = [
      {
        cycleId: 'cycle-1',
        strategyId: 'new-token-v1',
        recordedAt: '2026-04-18T02:00:00.000Z',
        tokenMint: 'mint-selected',
        tokenSymbol: 'SEL',
        poolAddress: 'pool-selected',
        runtimeMode: 'healthy',
        sessionPhase: 'active',
        positionId: 'position-1',
        action: 'dca-out',
        actualExitReason: 'spot-take-profit',
        openedAt: '2026-04-18T00:10:00.000Z',
        closedAt: '2026-04-18T02:00:00.000Z',
        entrySol: 0.2,
        maxObservedUpsidePct: 0.8,
        maxObservedDrawdownPct: 0.15,
        actualExitMetricValue: 0.4,
        takeProfitPctAtEntry: 20,
        stopLossPctAtEntry: 10,
        liveOrderSubmitted: true,
        parameterSnapshot: {
          takeProfitPct: 20,
          stopLossPct: 10,
          lpEnabled: false,
          maxHoldHours: 10
        },
        exitMetrics: {
          requestedPositionSol: 0.2,
          quoteOutputSol: 0.4,
          holdTimeMs: 7_200_000
        }
      }
    ];

    const samples = buildPoolDecisionSamples({
      candidateScans,
      watchlistSnapshots,
      outcomes
    });

    expect(samples).toHaveLength(2);

    const filteredSample = samples.find((sample) => sample.tokenMint === 'mint-filtered');
    expect(filteredSample).toMatchObject({
      tokenMint: 'mint-filtered',
      decision: {
        selected: false,
        blockedReason: 'min-liquidity'
      },
      futurePath: {
        observationCount: 2,
        latestWindowLabel: '4h',
        latestValueSol: 0.55,
        maxObservedValueSol: 0.75,
        minObservedValueSol: 0.55,
        bestWindowLabel: '1h',
        bestWindowValueSol: 0.75,
        forwardValueByWindowLabel: {
          '1h': 0.75,
          '4h': 0.55
        }
      },
      counterfactual: {
        selectedBaselineValueSol: 0.4,
        relativeToSelectedBaselineSol: 0.15,
        outperformedSelectedBaseline: true
      }
    });

    const selectedSample = samples.find((sample) => sample.tokenMint === 'mint-selected');
    expect(selectedSample).toMatchObject({
      tokenMint: 'mint-selected',
      futurePath: {
        observationCount: 1,
        latestWindowLabel: '1h',
        latestValueSol: 0.4,
        bestWindowLabel: '1h',
        bestWindowValueSol: 0.4,
        forwardValueByWindowLabel: {
          '1h': 0.4
        },
        outcomeCount: 1,
        latestOutcomeReason: 'spot-take-profit',
        latestExitMetricValue: 0.4
      }
    });
  });
});
