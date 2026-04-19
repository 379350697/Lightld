import { describe, expect, it } from 'vitest';

import {
  type CounterfactualReplayRecord,
  validateParameterProposals,
  type CounterfactualAnalysisResult,
  type OutcomeReplayRecord,
  type ParameterProposalRecord
} from '../../../src/evolution';

describe('validateParameterProposals', () => {
  it('marks a proposal as supported when matching counterfactual evidence is strong', () => {
    const proposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:filters.minLiquidityUsd:2026-04-19T12:00:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'draft',
        createdAt: '2026-04-19T12:00:00.000Z',
        updatedAt: '2026-04-19T12:00:00.000Z',
        targetPath: 'filters.minLiquidityUsd',
        oldValue: 1000,
        proposedValue: 900,
        evidenceWindowHours: 24,
        sampleSize: 5,
        rationale: 'Filtered winners later outperformed.',
        expectedImprovement: 'Capture more good pools.',
        riskNote: 'Can admit more noise.',
        uncertaintyNote: 'Needs review.',
        patchable: true
      }
    ];
    const counterfactualAnalysis: CounterfactualAnalysisResult = {
      summary: {
        totalSamples: 10,
        eligibleCounterfactualSamples: 5,
        positiveRelativeSamples: 4
      },
      pathSummaries: [
        {
          targetPath: 'filters.minLiquidityUsd',
          blockedReason: 'min-liquidity',
          sampleCount: 5,
          outperformCount: 4,
          outperformRate: 0.8,
          averageRelativeToSelectedBaselineSol: 0.21,
          averageBestWindowValueSol: 0.62,
          windowSummaries: [
            {
              windowLabel: '1h',
              sampleCount: 3,
              outperformCount: 2,
              outperformRate: 0.67,
              averageRelativeToSelectedBaselineSol: 0.18
            },
            {
              windowLabel: '4h',
              sampleCount: 2,
              outperformCount: 2,
              outperformRate: 1,
              averageRelativeToSelectedBaselineSol: 0.25
            }
          ],
          sliceSummaries: [
            {
              sliceLabel: 'earlier-half',
              sampleCount: 2,
              outperformCount: 1,
              outperformRate: 0.5,
              averageRelativeToSelectedBaselineSol: 0.11
            },
            {
              sliceLabel: 'later-half',
              sampleCount: 3,
              outperformCount: 3,
              outperformRate: 1,
              averageRelativeToSelectedBaselineSol: 0.27
            }
          ]
        }
      ],
      noActionReasons: []
    };

    const result = validateParameterProposals({
      proposals,
      counterfactualAnalysis,
      proposalReplays: [
        {
          proposalId: proposals[0].proposalId,
          targetPath: 'filters.minLiquidityUsd',
          admittedSampleCount: 3,
          positiveRelativeSamples: 3,
          averageRelativeToSelectedBaselineSol: 0.22,
          windowSummaries: [
            {
              windowLabel: '1h',
              sampleCount: 3,
              outperformCount: 3,
              outperformRate: 1,
              averageRelativeToSelectedBaselineSol: 0.22
            },
            {
              windowLabel: '4h',
              sampleCount: 2,
              outperformCount: 2,
              outperformRate: 1,
              averageRelativeToSelectedBaselineSol: 0.19
            }
          ],
          sliceSummaries: [
            {
              sliceLabel: 'earlier-half',
              sampleCount: 1,
              outperformCount: 1,
              outperformRate: 1,
              averageRelativeToSelectedBaselineSol: 0.25
            },
            {
              sliceLabel: 'later-half',
              sampleCount: 2,
              outperformCount: 2,
              outperformRate: 1,
              averageRelativeToSelectedBaselineSol: 0.21
            }
          ]
        }
      ]
    });

    expect(result).toEqual([
      expect.objectContaining({
        proposalId: proposals[0].proposalId,
        targetPath: 'filters.minLiquidityUsd',
        status: 'supported',
        sampleCount: 5,
        outperformRate: 0.8,
        averageRelativeToSelectedBaselineSol: 0.21,
        replayAdmittedSampleCount: 3,
        replayAverageRelativeToSelectedBaselineSol: 0.22,
        replayRecentSliceLabel: 'later-half',
        replayRecentSliceSampleCount: 2,
        replayRecentSliceOutperformRate: 1,
        replayRecentSliceAverageRelativeToSelectedBaselineSol: 0.21,
        replayLongHorizonWindowLabel: '4h',
        replayLongHorizonWindowSampleCount: 2,
        replayLongHorizonWindowOutperformRate: 1,
        replayLongHorizonWindowAverageRelativeToSelectedBaselineSol: 0.19,
        longHorizonWindowLabel: '4h',
        longHorizonWindowSampleCount: 2,
        longHorizonWindowOutperformRate: 1,
        longHorizonWindowAverageRelativeToSelectedBaselineSol: 0.25
      })
    ]);
  });

  it('marks a proposal as mixed when recent slices fail to hold up despite positive aggregate evidence', () => {
    const result = validateParameterProposals({
      proposals: [
        {
          proposalId: 'parameter:filters.minLiquidityUsd:2026-04-19T13:00:00.000Z',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-19T13:00:00.000Z',
          updatedAt: '2026-04-19T13:00:00.000Z',
          targetPath: 'filters.minLiquidityUsd',
          oldValue: 1000,
          proposedValue: 900,
          evidenceWindowHours: 24,
          sampleSize: 4,
          rationale: 'Filtered winners later outperformed.',
          expectedImprovement: 'Capture more good pools.',
          riskNote: 'Can admit more noise.',
          uncertaintyNote: 'Needs review.',
          patchable: true
        }
      ],
      counterfactualAnalysis: {
        summary: {
          totalSamples: 8,
          eligibleCounterfactualSamples: 4,
          positiveRelativeSamples: 3
        },
        pathSummaries: [
          {
            targetPath: 'filters.minLiquidityUsd',
            blockedReason: 'min-liquidity',
            sampleCount: 4,
            outperformCount: 3,
            outperformRate: 0.75,
            averageRelativeToSelectedBaselineSol: 0.12,
            averageBestWindowValueSol: 0.44,
            windowSummaries: [
              {
                windowLabel: '1h',
                sampleCount: 2,
                outperformCount: 2,
                outperformRate: 1,
                averageRelativeToSelectedBaselineSol: 0.21
              },
              {
                windowLabel: '4h',
                sampleCount: 2,
                outperformCount: 1,
                outperformRate: 0.5,
                averageRelativeToSelectedBaselineSol: -0.02
              }
            ],
            sliceSummaries: [
              {
                sliceLabel: 'earlier-half',
                sampleCount: 2,
                outperformCount: 2,
                outperformRate: 1,
                averageRelativeToSelectedBaselineSol: 0.31
              },
              {
                sliceLabel: 'later-half',
                sampleCount: 2,
                outperformCount: 1,
                outperformRate: 0.5,
                averageRelativeToSelectedBaselineSol: -0.02
              }
            ]
          }
        ],
        noActionReasons: []
      },
      proposalReplays: []
    });

    expect(result).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        status: 'mixed',
        note: expect.stringContaining('recent slice'),
        longHorizonWindowLabel: '4h'
      })
    ]);
  });

  it('marks a proposal as mixed when replay says the proposal would not actually admit any newly useful samples', () => {
    const proposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:filters.minLiquidityUsd:2026-04-19T15:00:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'draft',
        createdAt: '2026-04-19T15:00:00.000Z',
        updatedAt: '2026-04-19T15:00:00.000Z',
        targetPath: 'filters.minLiquidityUsd',
        oldValue: 1000,
        proposedValue: 900,
        evidenceWindowHours: 24,
        sampleSize: 5,
        rationale: 'Would admit more breakouts.',
        expectedImprovement: 'Capture missed pools.',
        riskNote: 'Can admit more noise.',
        uncertaintyNote: 'Needs replay.',
        patchable: true
      }
    ];
    const counterfactualAnalysis: CounterfactualAnalysisResult = {
      summary: {
        totalSamples: 9,
        eligibleCounterfactualSamples: 5,
        positiveRelativeSamples: 4
      },
      pathSummaries: [
        {
          targetPath: 'filters.minLiquidityUsd',
          blockedReason: 'min-liquidity',
          sampleCount: 5,
          outperformCount: 4,
          outperformRate: 0.8,
          averageRelativeToSelectedBaselineSol: 0.18,
          averageBestWindowValueSol: 0.55,
          windowSummaries: [
            {
              windowLabel: '1h',
              sampleCount: 5,
              outperformCount: 4,
              outperformRate: 0.8,
              averageRelativeToSelectedBaselineSol: 0.18
            }
          ],
          sliceSummaries: [
            {
              sliceLabel: 'earlier-half',
              sampleCount: 2,
              outperformCount: 1,
              outperformRate: 0.5,
              averageRelativeToSelectedBaselineSol: 0.09
            },
            {
              sliceLabel: 'later-half',
              sampleCount: 3,
              outperformCount: 3,
              outperformRate: 1,
              averageRelativeToSelectedBaselineSol: 0.24
            }
          ]
        }
      ],
      noActionReasons: []
    };
    const proposalReplays: CounterfactualReplayRecord[] = [
      {
        proposalId: proposals[0].proposalId,
        targetPath: 'filters.minLiquidityUsd',
        admittedSampleCount: 0,
        positiveRelativeSamples: 0,
        averageRelativeToSelectedBaselineSol: null,
        windowSummaries: [],
        sliceSummaries: []
      }
    ];

    const result = validateParameterProposals({
      proposals,
      counterfactualAnalysis,
      proposalReplays
    });

    expect(result).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        status: 'mixed',
        note: expect.stringContaining('replay'),
        replayAdmittedSampleCount: 0
      })
    ]);
  });

  it('marks a proposal as mixed when the long-horizon window turns negative despite strong aggregate and recent slices', () => {
    const result = validateParameterProposals({
      proposals: [
        {
          proposalId: 'parameter:filters.minLiquidityUsd:2026-04-19T14:00:00.000Z',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-19T14:00:00.000Z',
          updatedAt: '2026-04-19T14:00:00.000Z',
          targetPath: 'filters.minLiquidityUsd',
          oldValue: 1000,
          proposedValue: 900,
          evidenceWindowHours: 24,
          sampleSize: 5,
          rationale: 'Filtered winners later outperformed.',
          expectedImprovement: 'Capture more good pools.',
          riskNote: 'Can admit more noise.',
          uncertaintyNote: 'Needs review.',
          patchable: true
        }
      ],
      counterfactualAnalysis: {
        summary: {
          totalSamples: 10,
          eligibleCounterfactualSamples: 5,
          positiveRelativeSamples: 4
        },
        pathSummaries: [
          {
            targetPath: 'filters.minLiquidityUsd',
            blockedReason: 'min-liquidity',
            sampleCount: 5,
            outperformCount: 4,
            outperformRate: 0.8,
            averageRelativeToSelectedBaselineSol: 0.18,
            averageBestWindowValueSol: 0.55,
            windowSummaries: [
              {
                windowLabel: '1h',
                sampleCount: 5,
                outperformCount: 4,
                outperformRate: 0.8,
                averageRelativeToSelectedBaselineSol: 0.19
              },
              {
                windowLabel: '24h',
                sampleCount: 3,
                outperformCount: 1,
                outperformRate: 0.33,
                averageRelativeToSelectedBaselineSol: -0.04
              }
            ],
            sliceSummaries: [
              {
                sliceLabel: 'earlier-half',
                sampleCount: 2,
                outperformCount: 1,
                outperformRate: 0.5,
                averageRelativeToSelectedBaselineSol: 0.09
              },
              {
                sliceLabel: 'later-half',
                sampleCount: 3,
                outperformCount: 3,
                outperformRate: 1,
                averageRelativeToSelectedBaselineSol: 0.24
              }
            ]
          }
        ],
        noActionReasons: []
      }
    });

    expect(result).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        status: 'mixed',
        note: expect.stringContaining('24h'),
        longHorizonWindowLabel: '24h',
        longHorizonWindowSampleCount: 3,
        longHorizonWindowOutperformRate: 0.33,
        longHorizonWindowAverageRelativeToSelectedBaselineSol: -0.04
      })
    ]);
  });

  it('marks a proposal as mixed when replay recent slices fail even though aggregate counterfactual evidence is strong', () => {
    const result = validateParameterProposals({
      proposals: [
        {
          proposalId: 'parameter:filters.minLiquidityUsd:2026-04-19T15:30:00.000Z',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-19T15:30:00.000Z',
          updatedAt: '2026-04-19T15:30:00.000Z',
          targetPath: 'filters.minLiquidityUsd',
          oldValue: 1000,
          proposedValue: 900,
          evidenceWindowHours: 24,
          sampleSize: 5,
          rationale: 'Would admit more breakouts.',
          expectedImprovement: 'Capture missed pools.',
          riskNote: 'Can admit more noise.',
          uncertaintyNote: 'Needs replay.',
          patchable: true
        }
      ],
      counterfactualAnalysis: {
        summary: {
          totalSamples: 9,
          eligibleCounterfactualSamples: 5,
          positiveRelativeSamples: 4
        },
        pathSummaries: [
          {
            targetPath: 'filters.minLiquidityUsd',
            blockedReason: 'min-liquidity',
            sampleCount: 5,
            outperformCount: 4,
            outperformRate: 0.8,
            averageRelativeToSelectedBaselineSol: 0.18,
            averageBestWindowValueSol: 0.55,
            windowSummaries: [
              {
                windowLabel: '1h',
                sampleCount: 5,
                outperformCount: 4,
                outperformRate: 0.8,
                averageRelativeToSelectedBaselineSol: 0.18
              },
              {
                windowLabel: '4h',
                sampleCount: 3,
                outperformCount: 2,
                outperformRate: 0.67,
                averageRelativeToSelectedBaselineSol: 0.11
              }
            ],
            sliceSummaries: [
              {
                sliceLabel: 'earlier-half',
                sampleCount: 2,
                outperformCount: 1,
                outperformRate: 0.5,
                averageRelativeToSelectedBaselineSol: 0.09
              },
              {
                sliceLabel: 'later-half',
                sampleCount: 3,
                outperformCount: 3,
                outperformRate: 1,
                averageRelativeToSelectedBaselineSol: 0.24
              }
            ]
          }
        ],
        noActionReasons: []
      },
      proposalReplays: [
        {
          proposalId: 'parameter:filters.minLiquidityUsd:2026-04-19T15:30:00.000Z',
          targetPath: 'filters.minLiquidityUsd',
          admittedSampleCount: 2,
          positiveRelativeSamples: 1,
          averageRelativeToSelectedBaselineSol: 0.03,
          windowSummaries: [
            {
              windowLabel: '1h',
              sampleCount: 2,
              outperformCount: 1,
              outperformRate: 0.5,
              averageRelativeToSelectedBaselineSol: 0.03
            },
            {
              windowLabel: '4h',
              sampleCount: 1,
              outperformCount: 1,
              outperformRate: 1,
              averageRelativeToSelectedBaselineSol: 0.06
            }
          ],
          sliceSummaries: [
            {
              sliceLabel: 'earlier-half',
              sampleCount: 1,
              outperformCount: 1,
              outperformRate: 1,
              averageRelativeToSelectedBaselineSol: 0.08
            },
            {
              sliceLabel: 'later-half',
              sampleCount: 1,
              outperformCount: 0,
              outperformRate: 0,
              averageRelativeToSelectedBaselineSol: -0.02
            }
          ]
        }
      ]
    });

    expect(result).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        status: 'mixed',
        note: expect.stringContaining('replay recent slice'),
        replayRecentSliceLabel: 'later-half',
        replayRecentSliceSampleCount: 1,
        replayRecentSliceOutperformRate: 0,
        replayRecentSliceAverageRelativeToSelectedBaselineSol: -0.02
      })
    ]);
  });

  it('marks a proposal as insufficient_evidence when no matching counterfactual path exists', () => {
    const result = validateParameterProposals({
      proposals: [
        {
          proposalId: 'parameter:riskThresholds.takeProfitPct:2026-04-19T12:00:00.000Z',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-19T12:00:00.000Z',
          updatedAt: '2026-04-19T12:00:00.000Z',
          targetPath: 'riskThresholds.takeProfitPct',
          oldValue: 20,
          proposedValue: 22,
          evidenceWindowHours: 24,
          sampleSize: 4,
          rationale: 'Take-profit may be too tight.',
          expectedImprovement: 'Hold winners longer.',
          riskNote: 'Could give back gains.',
          uncertaintyNote: 'Needs follow-through.',
          patchable: true
        }
      ],
      counterfactualAnalysis: {
        summary: {
          totalSamples: 0,
          eligibleCounterfactualSamples: 0,
          positiveRelativeSamples: 0
        },
        pathSummaries: [],
        noActionReasons: ['data_coverage_gaps']
      }
    });

    expect(result).toEqual([
      expect.objectContaining({
        targetPath: 'riskThresholds.takeProfitPct',
        status: 'insufficient_evidence'
      })
    ]);
  });

  it('marks a take-profit proposal as supported when outcome replay is strong even without filter-side counterfactual summaries', () => {
    const proposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:riskThresholds.takeProfitPct:2026-04-19T18:00:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'draft',
        createdAt: '2026-04-19T18:00:00.000Z',
        updatedAt: '2026-04-19T18:00:00.000Z',
        targetPath: 'riskThresholds.takeProfitPct',
        oldValue: 20,
        proposedValue: 24,
        evidenceWindowHours: 24,
        sampleSize: 4,
        rationale: 'Winners kept running after the current take-profit.',
        expectedImprovement: 'Hold stronger winners longer.',
        riskNote: 'Can give back gains.',
        uncertaintyNote: 'Needs replay confirmation.',
        patchable: true
      }
    ];
    const outcomeReplays: OutcomeReplayRecord[] = [
      {
        proposalId: proposals[0].proposalId,
        targetPath: 'riskThresholds.takeProfitPct',
        replayableSampleCount: 3,
        supportiveSampleCount: 2,
        supportRate: 0.6667,
        averageHeadroomPct: 6.25,
        windowSummaries: [
          {
            windowLabel: '15m',
            replayableSampleCount: 2,
            supportiveSampleCount: 1,
            supportRate: 0.5,
            averageHeadroomPct: 4
          },
          {
            windowLabel: '1h',
            replayableSampleCount: 2,
            supportiveSampleCount: 2,
            supportRate: 1,
            averageHeadroomPct: 7.5
          }
        ],
        sliceSummaries: [
          {
            sliceLabel: 'earlier-half',
            replayableSampleCount: 1,
            supportiveSampleCount: 0,
            supportRate: 0,
            averageHeadroomPct: null
          },
          {
            sliceLabel: 'later-half',
            replayableSampleCount: 2,
            supportiveSampleCount: 2,
            supportRate: 1,
            averageHeadroomPct: 6.25
          }
        ]
      }
    ];

    const result = validateParameterProposals({
      proposals,
      counterfactualAnalysis: {
        summary: {
          totalSamples: 0,
          eligibleCounterfactualSamples: 0,
          positiveRelativeSamples: 0
        },
        pathSummaries: [],
        noActionReasons: ['data_coverage_gaps']
      },
      proposalReplays: [],
      outcomeReplays
    });

    expect(result).toEqual([
      expect.objectContaining({
        targetPath: 'riskThresholds.takeProfitPct',
        status: 'supported',
        note: expect.stringContaining('outcome replay'),
        outcomeReplayableSampleCount: 3,
        outcomeSupportiveSampleCount: 2,
        outcomeSupportRate: 0.6667,
        outcomeAverageHeadroomPct: 6.25,
        outcomeRecentWindowLabel: '15m',
        outcomeRecentWindowReplayableSampleCount: 2,
        outcomeRecentWindowSupportiveSampleCount: 1,
        outcomeRecentWindowSupportRate: 0.5,
        outcomeRecentWindowAverageHeadroomPct: 4,
        outcomeLongHorizonWindowLabel: '1h',
        outcomeLongHorizonWindowReplayableSampleCount: 2,
        outcomeLongHorizonWindowSupportiveSampleCount: 2,
        outcomeLongHorizonWindowSupportRate: 1,
        outcomeLongHorizonWindowAverageHeadroomPct: 7.5,
        outcomeRecentSliceLabel: 'later-half',
        outcomeRecentSliceReplayableSampleCount: 2,
        outcomeRecentSliceSupportiveSampleCount: 2,
        outcomeRecentSliceSupportRate: 1,
        outcomeRecentSliceAverageHeadroomPct: 6.25
      })
    ]);
  });
});
