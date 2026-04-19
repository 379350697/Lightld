import { describe, expect, it } from 'vitest';

import {
  validateParameterProposals,
  type CounterfactualAnalysisResult,
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
      counterfactualAnalysis
    });

    expect(result).toEqual([
      expect.objectContaining({
        proposalId: proposals[0].proposalId,
        targetPath: 'filters.minLiquidityUsd',
        status: 'supported',
        sampleCount: 5,
        outperformRate: 0.8,
        averageRelativeToSelectedBaselineSol: 0.21
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
      }
    });

    expect(result).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        status: 'mixed',
        note: expect.stringContaining('recent slice')
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
});
