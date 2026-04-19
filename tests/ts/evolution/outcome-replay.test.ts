import { describe, expect, it } from 'vitest';

import {
  replayOutcomeProposals,
  type LiveCycleOutcomeRecord,
  type ParameterProposalRecord,
  type WatchlistSnapshotRecord
} from '../../../src/evolution';

describe('replayOutcomeProposals', () => {
  it('replays a wider take-profit proposal against recorded exit headroom', () => {
    const proposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:riskThresholds.takeProfitPct:2026-04-19T17:00:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'draft',
        createdAt: '2026-04-19T17:00:00.000Z',
        updatedAt: '2026-04-19T17:00:00.000Z',
        targetPath: 'riskThresholds.takeProfitPct',
        oldValue: 20,
        proposedValue: 24,
        evidenceWindowHours: 24,
        sampleSize: 4,
        rationale: 'Later upside suggests TP may be tight.',
        expectedImprovement: 'Hold winners longer.',
        riskNote: 'Can give back gains.',
        uncertaintyNote: 'Needs replay.',
        patchable: true
      }
    ];
    const outcomes: LiveCycleOutcomeRecord[] = [
      buildOutcome({
        cycleId: 'cycle-hit',
        tokenMint: 'mint-hit',
        actualExitReason: 'take-profit-hit',
        takeProfitPctAtEntry: 20,
        maxObservedUpsidePct: 33.33
      }),
      buildOutcome({
        cycleId: 'cycle-miss',
        tokenMint: 'mint-miss',
        actualExitReason: 'take-profit-hit',
        takeProfitPctAtEntry: 20,
        maxObservedUpsidePct: 21.5
      })
    ];

    const result = replayOutcomeProposals({
      proposals,
      outcomes,
      watchlistSnapshots: []
    });

    expect(result).toEqual([
      expect.objectContaining({
        proposalId: proposals[0].proposalId,
        targetPath: 'riskThresholds.takeProfitPct',
        replayableSampleCount: 2,
        supportiveSampleCount: 1,
        supportRate: 0.5,
        averageHeadroomPct: 9.33
      })
    ]);
  });

  it('returns an empty replay summary for unsupported paths', () => {
    const result = replayOutcomeProposals({
      proposals: [
        {
          proposalId: 'parameter:filters.minLiquidityUsd:2026-04-19T17:30:00.000Z',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-19T17:30:00.000Z',
          updatedAt: '2026-04-19T17:30:00.000Z',
          targetPath: 'filters.minLiquidityUsd',
          oldValue: 1000,
          proposedValue: 900,
          evidenceWindowHours: 24,
          sampleSize: 4,
          rationale: 'Filter replay belongs elsewhere.',
          expectedImprovement: 'Capture missed pools.',
          riskNote: 'Can admit noise.',
          uncertaintyNote: 'Not outcome-based.',
          patchable: true
        }
      ],
      outcomes: [buildOutcome({ cycleId: 'cycle-ignored' })],
      watchlistSnapshots: []
    });

    expect(result).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        replayableSampleCount: 0,
        supportiveSampleCount: 0,
        averageHeadroomPct: null
      })
    ]);
  });

  it('replays a wider lp take-profit proposal against realized lp net pnl exits', () => {
    const proposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:lpConfig.takeProfitNetPnlPct:2026-04-19T18:30:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'draft',
        createdAt: '2026-04-19T18:30:00.000Z',
        updatedAt: '2026-04-19T18:30:00.000Z',
        targetPath: 'lpConfig.takeProfitNetPnlPct',
        oldValue: 30,
        proposedValue: 35,
        evidenceWindowHours: 24,
        sampleSize: 4,
        rationale: 'LP winners kept running after the current take-profit.',
        expectedImprovement: 'Hold LP winners longer.',
        riskNote: 'Can give back gains.',
        uncertaintyNote: 'Needs replay.',
        patchable: true
      }
    ];
    const outcomes: LiveCycleOutcomeRecord[] = [
      buildOutcome({
        cycleId: 'lp-hit',
        tokenMint: 'lp-hit',
        action: 'withdraw-lp',
        actualExitReason: 'lp-take-profit',
        lpTakeProfitNetPnlPctAtEntry: 30,
        actualExitMetricValue: 41
      }),
      buildOutcome({
        cycleId: 'lp-miss',
        tokenMint: 'lp-miss',
        action: 'withdraw-lp',
        actualExitReason: 'lp-take-profit',
        lpTakeProfitNetPnlPctAtEntry: 30,
        actualExitMetricValue: 32
      })
    ];

    const result = replayOutcomeProposals({
      proposals,
      outcomes,
      watchlistSnapshots: []
    });

    expect(result).toEqual([
      expect.objectContaining({
        proposalId: proposals[0].proposalId,
        targetPath: 'lpConfig.takeProfitNetPnlPct',
        replayableSampleCount: 2,
        supportiveSampleCount: 1,
        supportRate: 0.5,
        averageHeadroomPct: 6
      })
    ]);
  });

  it('replays a tighter stop-loss proposal against post-exit downside follow-through', () => {
    const proposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:riskThresholds.stopLossPct:2026-04-19T19:00:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'draft',
        createdAt: '2026-04-19T19:00:00.000Z',
        updatedAt: '2026-04-19T19:00:00.000Z',
        targetPath: 'riskThresholds.stopLossPct',
        oldValue: 12,
        proposedValue: 10,
        evidenceWindowHours: 24,
        sampleSize: 4,
        rationale: 'Exited stop-loss names kept dropping after exit.',
        expectedImprovement: 'Cut losses faster.',
        riskNote: 'Can exit earlier on noise.',
        uncertaintyNote: 'Needs replay.',
        patchable: true
      }
    ];
    const outcomes: LiveCycleOutcomeRecord[] = [
      buildOutcome({
        cycleId: 'sl-hit',
        tokenMint: 'mint-sl-hit',
        tokenSymbol: 'SLH',
        actualExitReason: 'stop-loss-hit',
        stopLossPctAtEntry: 12,
        exitMetrics: {
          requestedPositionSol: 0.15,
          quoteOutputSol: 0.16
        }
      }),
      buildOutcome({
        cycleId: 'sl-miss',
        tokenMint: 'mint-sl-miss',
        tokenSymbol: 'SLM',
        actualExitReason: 'stop-loss-hit',
        stopLossPctAtEntry: 12,
        exitMetrics: {
          requestedPositionSol: 0.15,
          quoteOutputSol: 0.16
        }
      })
    ];
    const watchlistSnapshots: WatchlistSnapshotRecord[] = [
      buildWatchlistSnapshot({
        watchId: 'watch-sl-hit',
        tokenMint: 'mint-sl-hit',
        tokenSymbol: 'SLH',
        observationAt: '2026-04-19T01:30:00.000Z',
        currentValueSol: 0.1
      }),
      buildWatchlistSnapshot({
        watchId: 'watch-sl-miss',
        tokenMint: 'mint-sl-miss',
        tokenSymbol: 'SLM',
        observationAt: '2026-04-19T01:30:00.000Z',
        currentValueSol: 0.15
      })
    ];

    const result = replayOutcomeProposals({
      proposals,
      outcomes,
      watchlistSnapshots
    });

    expect(result).toEqual([
      expect.objectContaining({
        proposalId: proposals[0].proposalId,
        targetPath: 'riskThresholds.stopLossPct',
        replayableSampleCount: 2,
        supportiveSampleCount: 1,
        supportRate: 0.5,
        averageHeadroomPct: 37.5
      })
    ]);
  });

  it('replays a tighter lp stop-loss proposal against post-exit lp downside follow-through', () => {
    const proposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:lpConfig.stopLossNetPnlPct:2026-04-19T19:15:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'draft',
        createdAt: '2026-04-19T19:15:00.000Z',
        updatedAt: '2026-04-19T19:15:00.000Z',
        targetPath: 'lpConfig.stopLossNetPnlPct',
        oldValue: 20,
        proposedValue: 18,
        evidenceWindowHours: 24,
        sampleSize: 4,
        rationale: 'LP stop-loss exits kept sliding afterward.',
        expectedImprovement: 'Exit LP losses earlier.',
        riskNote: 'Can stop out too early.',
        uncertaintyNote: 'Needs replay.',
        patchable: true
      }
    ];
    const outcomes: LiveCycleOutcomeRecord[] = [
      buildOutcome({
        cycleId: 'lp-sl-hit',
        tokenMint: 'mint-lp-sl-hit',
        tokenSymbol: 'LPSH',
        action: 'withdraw-lp',
        actualExitReason: 'lp-stop-loss',
        lpStopLossNetPnlPctAtEntry: 20,
        actualExitMetricValue: -24,
        exitMetrics: {
          requestedPositionSol: 0.15,
          lpCurrentValueSol: 0.08,
          lpNetPnlPct: -24,
          lpUnclaimedFeeSol: 0.01
        }
      }),
      buildOutcome({
        cycleId: 'lp-sl-miss',
        tokenMint: 'mint-lp-sl-miss',
        tokenSymbol: 'LPSM',
        action: 'withdraw-lp',
        actualExitReason: 'lp-stop-loss',
        lpStopLossNetPnlPctAtEntry: 20,
        actualExitMetricValue: -21,
        exitMetrics: {
          requestedPositionSol: 0.15,
          lpCurrentValueSol: 0.08,
          lpNetPnlPct: -21,
          lpUnclaimedFeeSol: 0.01
        }
      })
    ];
    const watchlistSnapshots: WatchlistSnapshotRecord[] = [
      buildWatchlistSnapshot({
        watchId: 'watch-lp-sl-hit',
        tokenMint: 'mint-lp-sl-hit',
        tokenSymbol: 'LPSH',
        observationAt: '2026-04-19T01:30:00.000Z',
        currentValueSol: 0.04,
        hasLpPosition: true
      }),
      buildWatchlistSnapshot({
        watchId: 'watch-lp-sl-miss',
        tokenMint: 'mint-lp-sl-miss',
        tokenSymbol: 'LPSM',
        observationAt: '2026-04-19T01:30:00.000Z',
        currentValueSol: 0.07,
        hasLpPosition: true
      })
    ];

    const result = replayOutcomeProposals({
      proposals,
      outcomes,
      watchlistSnapshots
    });

    expect(result).toEqual([
      expect.objectContaining({
        proposalId: proposals[0].proposalId,
        targetPath: 'lpConfig.stopLossNetPnlPct',
        replayableSampleCount: 2,
        supportiveSampleCount: 1,
        supportRate: 0.5,
        averageHeadroomPct: 50
      })
    ]);
  });

  it('replays a wider sol-depletion exit proposal against post-exit lp upside follow-through with long windows and slices', () => {
    const proposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:lpConfig.solDepletionExitBins:2026-04-19T19:30:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'draft',
        createdAt: '2026-04-19T19:30:00.000Z',
        updatedAt: '2026-04-19T19:30:00.000Z',
        targetPath: 'lpConfig.solDepletionExitBins',
        oldValue: 60,
        proposedValue: 66,
        evidenceWindowHours: 24,
        sampleSize: 4,
        rationale: 'Sol depletion exits still had room to run.',
        expectedImprovement: 'Hold LP trend continuation longer.',
        riskNote: 'Can stay exposed longer.',
        uncertaintyNote: 'Needs replay.',
        patchable: true
      }
    ];
    const outcomes: LiveCycleOutcomeRecord[] = [
      buildOutcome({
        cycleId: 'sol-hit',
        tokenMint: 'mint-sol-hit',
        tokenSymbol: 'SDH',
        action: 'withdraw-lp',
        actualExitReason: 'sol-depletion-hit',
        solDepletionExitBinsAtEntry: 60,
        exitMetrics: {
          requestedPositionSol: 0.15,
          lpCurrentValueSol: 0.2,
          lpSolDepletedBins: 60,
          lpUnclaimedFeeSol: 0.01
        }
      }),
      buildOutcome({
        cycleId: 'sol-miss',
        tokenMint: 'mint-sol-miss',
        tokenSymbol: 'SDM',
        action: 'withdraw-lp',
        actualExitReason: 'sol-depletion-hit',
        solDepletionExitBinsAtEntry: 60,
        exitMetrics: {
          requestedPositionSol: 0.15,
          lpCurrentValueSol: 0.2,
          lpSolDepletedBins: 60,
          lpUnclaimedFeeSol: 0.01
        }
      })
    ];
    const watchlistSnapshots: WatchlistSnapshotRecord[] = [
      buildWatchlistSnapshot({
        watchId: 'watch-sol-hit-15m',
        tokenMint: 'mint-sol-hit',
        tokenSymbol: 'SDH',
        observationAt: '2026-04-19T00:45:00.000Z',
        windowLabel: '15m',
        currentValueSol: 0.18,
        hasLpPosition: true
      }),
      buildWatchlistSnapshot({
        watchId: 'watch-sol-hit-1h',
        tokenMint: 'mint-sol-hit',
        tokenSymbol: 'SDH',
        observationAt: '2026-04-19T01:30:00.000Z',
        windowLabel: '1h',
        currentValueSol: 0.26,
        hasLpPosition: true
      }),
      buildWatchlistSnapshot({
        watchId: 'watch-sol-hit-4h',
        tokenMint: 'mint-sol-hit',
        tokenSymbol: 'SDH',
        observationAt: '2026-04-19T04:30:00.000Z',
        windowLabel: '4h',
        currentValueSol: 0.31,
        hasLpPosition: true
      }),
      buildWatchlistSnapshot({
        watchId: 'watch-sol-hit-24h',
        tokenMint: 'mint-sol-hit',
        tokenSymbol: 'SDH',
        observationAt: '2026-04-20T00:30:00.000Z',
        windowLabel: '24h',
        currentValueSol: 0.33,
        hasLpPosition: true
      }),
      buildWatchlistSnapshot({
        watchId: 'watch-sol-miss-15m',
        tokenMint: 'mint-sol-miss',
        tokenSymbol: 'SDM',
        observationAt: '2026-04-19T00:45:00.000Z',
        windowLabel: '15m',
        currentValueSol: 0.19,
        hasLpPosition: true
      }),
      buildWatchlistSnapshot({
        watchId: 'watch-sol-miss-1h',
        tokenMint: 'mint-sol-miss',
        tokenSymbol: 'SDM',
        observationAt: '2026-04-19T01:30:00.000Z',
        windowLabel: '1h',
        currentValueSol: 0.22,
        hasLpPosition: true
      }),
      buildWatchlistSnapshot({
        watchId: 'watch-sol-miss-4h',
        tokenMint: 'mint-sol-miss',
        tokenSymbol: 'SDM',
        observationAt: '2026-04-19T04:30:00.000Z',
        windowLabel: '4h',
        currentValueSol: 0.21,
        hasLpPosition: true
      }),
      buildWatchlistSnapshot({
        watchId: 'watch-sol-miss-24h',
        tokenMint: 'mint-sol-miss',
        tokenSymbol: 'SDM',
        observationAt: '2026-04-20T00:30:00.000Z',
        windowLabel: '24h',
        currentValueSol: 0.2,
        hasLpPosition: true
      })
    ];

    const result = replayOutcomeProposals({
      proposals,
      outcomes,
      watchlistSnapshots
    });

    expect(result).toEqual([
      expect.objectContaining({
        proposalId: proposals[0].proposalId,
        targetPath: 'lpConfig.solDepletionExitBins',
        replayableSampleCount: 8,
        supportiveSampleCount: 3,
        supportRate: 0.375,
        averageHeadroomPct: 50,
        windowSummaries: [
          expect.objectContaining({
            windowLabel: '15m',
            replayableSampleCount: 2,
            supportiveSampleCount: 0,
            supportRate: 0
          }),
          expect.objectContaining({
            windowLabel: '1h',
            replayableSampleCount: 2,
            supportiveSampleCount: 1,
            supportRate: 0.5,
            averageHeadroomPct: 30
          }),
          expect.objectContaining({
            windowLabel: '4h',
            replayableSampleCount: 2,
            supportiveSampleCount: 1,
            supportRate: 0.5,
            averageHeadroomPct: 55
          }),
          expect.objectContaining({
            windowLabel: '24h',
            replayableSampleCount: 2,
            supportiveSampleCount: 1,
            supportRate: 0.5,
            averageHeadroomPct: 65
          })
        ],
        sliceSummaries: [
          expect.objectContaining({
            sliceLabel: 'earlier-half',
            replayableSampleCount: 4,
            supportiveSampleCount: 1,
            supportRate: 0.25,
            averageHeadroomPct: 30
          }),
          expect.objectContaining({
            sliceLabel: 'later-half',
            replayableSampleCount: 4,
            supportiveSampleCount: 2,
            supportRate: 0.5,
            averageHeadroomPct: 60
          })
        ]
      })
    ]);
  });
});

function buildOutcome(overrides: Partial<LiveCycleOutcomeRecord>): LiveCycleOutcomeRecord {
  return {
    cycleId: 'cycle-1',
    strategyId: 'new-token-v1',
    recordedAt: '2026-04-19T00:30:00.000Z',
    tokenMint: 'mint-1',
    tokenSymbol: 'SAFE',
    poolAddress: 'pool-1',
    runtimeMode: 'healthy',
    sessionPhase: 'active',
    positionId: 'position-1',
    action: 'dca-out',
    actualExitReason: 'take-profit-hit',
    openedAt: '2026-04-19T00:00:00.000Z',
    closedAt: '2026-04-19T00:30:00.000Z',
    entrySol: 0.15,
    maxObservedUpsidePct: 25,
    maxObservedDrawdownPct: 3,
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
      lpEnabled: false,
      maxHoldHours: 10
    },
    exitMetrics: {
      requestedPositionSol: 0.15,
      quoteOutputSol: 0.2,
      holdTimeMs: 1_800_000
    },
    ...overrides
  };
}

function buildWatchlistSnapshot(overrides: Partial<WatchlistSnapshotRecord>): WatchlistSnapshotRecord {
  return {
    watchId: 'watch-1',
    trackedSince: '2026-04-19T00:00:00.000Z',
    strategyId: 'new-token-v1',
    tokenMint: 'mint-1',
    tokenSymbol: 'SAFE',
    poolAddress: 'pool-1',
    observationAt: '2026-04-19T01:00:00.000Z',
    windowLabel: '1h',
    currentValueSol: 0.25,
    liquidityUsd: 12000,
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
