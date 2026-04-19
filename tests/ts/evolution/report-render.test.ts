import { describe, expect, it } from 'vitest';

import {
  renderEvolutionReport,
  type CounterfactualAnalysisResult,
  type ProposalValidationRecord
} from '../../../src/evolution';

describe('renderEvolutionReport', () => {
  it('renders markdown and JSON artifacts for an evidence-backed report', () => {
    const rendered = renderEvolutionReport({
      strategyId: 'new-token-v1',
      generatedAt: '2026-04-18T12:00:00.000Z',
      evidenceSnapshot: {
        capturedAt: '2026-04-18T12:00:00.000Z',
        timeWindowLabel: 'all-available',
        sampleCounts: {
          candidateScans: 12,
          poolDecisionSamples: 18,
          watchlistSnapshots: 24,
          outcomes: 8
        },
        strategyConfigPath: 'src/config/strategies/new-token-v1.yaml',
        coverageScore: 0.84,
        regimeScore: 0.79,
        proposalReadinessScore: 0.82,
        coverageBreakdown: {
          candidateScanCoverage: 1,
          watchlistCoverage: 1,
          outcomeCoverage: 1,
          followThroughCoverage: 0.75
        },
        regimeLabels: ['active-observation'],
        headlineDiagnostics: ['5 missed opportunities exceeded selected baseline.'],
        proposalIds: ['parameter:filters.minLiquidityUsd:2026-04-18T12:00:00.000Z']
      },
      evidenceCounts: {
        candidateScans: 12,
        poolDecisionSamples: 18,
        watchlistSnapshots: 24,
        outcomes: 8
      },
      filterAnalysis: {
        summary: {
          totalScans: 12,
          totalCandidates: 48,
          selectedCandidateCount: 12,
          filteredCandidateCount: 36,
          blockedReasonCounts: [
            { reason: 'min-liquidity', count: 10 }
          ],
          missedOpportunityCount: 5
        },
        findings: [],
        noActionReasons: []
      },
      outcomeAnalysis: {
        summary: {
          totalOutcomes: 8,
          matchedFollowThroughCount: 6
        },
        findings: [],
        noActionReasons: []
      },
      counterfactualAnalysis: buildCounterfactualAnalysis(),
      proposalValidations: buildProposalValidations(),
      parameterProposals: [
        {
          proposalId: 'parameter:filters.minLiquidityUsd:2026-04-18T12:00:00.000Z',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-18T12:00:00.000Z',
          updatedAt: '2026-04-18T12:00:00.000Z',
          targetPath: 'filters.minLiquidityUsd',
          oldValue: 1000,
          proposedValue: 900,
          evidenceWindowHours: 24,
          sampleSize: 5,
          rationale: 'Missed breakouts were filtered.',
          expectedImprovement: 'Capture stronger follow-through.',
          riskNote: 'Could admit noisier pools.',
          uncertaintyNote: 'Depends on regime.',
          patchable: true
        }
      ],
      systemProposals: [],
      noActionReasons: []
    });

    expect(rendered.json.parameterProposals).toHaveLength(1);
    expect(rendered.markdown).toContain('# Evolution Report');
    expect(rendered.markdown).toContain('filters.minLiquidityUsd');
    expect(rendered.markdown).toContain('Candidate scans: 12');
    expect(rendered.markdown).toContain('Pool decision samples: 18');
    expect(rendered.markdown).toContain('Eligible counterfactual samples: 9');
    expect(rendered.markdown).toContain('Supported validations: 1');
    expect(rendered.markdown).toContain('filters.minLiquidityUsd');
    expect(rendered.markdown).toContain('Evidence snapshot: all-available');
    expect(rendered.markdown).toContain('Coverage score: 0.84');
    expect(rendered.json.evidenceSnapshot.proposalIds).toEqual([
      'parameter:filters.minLiquidityUsd:2026-04-18T12:00:00.000Z'
    ]);
  });

  it('renders a no-action report when evidence is too thin', () => {
    const rendered = renderEvolutionReport({
      strategyId: 'new-token-v1',
      generatedAt: '2026-04-18T12:00:00.000Z',
      evidenceSnapshot: {
        capturedAt: '2026-04-18T12:00:00.000Z',
        timeWindowLabel: 'all-available',
        sampleCounts: {
          candidateScans: 0,
          poolDecisionSamples: 0,
          watchlistSnapshots: 0,
          outcomes: 0
        },
        strategyConfigPath: 'src/config/strategies/new-token-v1.yaml',
        coverageScore: 0,
        regimeScore: 0,
        proposalReadinessScore: 0,
        coverageBreakdown: {
          candidateScanCoverage: 0,
          watchlistCoverage: 0,
          outcomeCoverage: 0,
          followThroughCoverage: 0
        },
        regimeLabels: ['cold-start'],
        headlineDiagnostics: ['No evidence has been collected yet.'],
        proposalIds: []
      },
      evidenceCounts: {
        candidateScans: 0,
        poolDecisionSamples: 0,
        watchlistSnapshots: 0,
        outcomes: 0
      },
      filterAnalysis: {
        summary: {
          totalScans: 0,
          totalCandidates: 0,
          selectedCandidateCount: 0,
          filteredCandidateCount: 0,
          blockedReasonCounts: [],
          missedOpportunityCount: 0
        },
        findings: [],
        noActionReasons: ['insufficient_sample_size']
      },
      outcomeAnalysis: {
        summary: {
          totalOutcomes: 0,
          matchedFollowThroughCount: 0
        },
        findings: [],
        noActionReasons: ['insufficient_sample_size']
      },
      counterfactualAnalysis: {
        summary: {
          totalSamples: 0,
          eligibleCounterfactualSamples: 0,
          positiveRelativeSamples: 0
        },
        pathSummaries: [],
        noActionReasons: ['insufficient_sample_size']
      },
      proposalValidations: [],
      parameterProposals: [],
      systemProposals: [],
      noActionReasons: ['no_safe_parameter_proposal']
    });

    expect(rendered.markdown).toContain('No safe parameter proposals');
    expect(rendered.markdown).toContain('Evidence snapshot: all-available');
    expect(rendered.json.noActionReasons).toContain('no_safe_parameter_proposal');
  });
});

function buildCounterfactualAnalysis(): CounterfactualAnalysisResult {
  return {
    summary: {
      totalSamples: 18,
      eligibleCounterfactualSamples: 9,
      positiveRelativeSamples: 6
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
            averageRelativeToSelectedBaselineSol: 0.12
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
}

function buildProposalValidations(): ProposalValidationRecord[] {
  return [
    {
      proposalId: 'parameter:filters.minLiquidityUsd:2026-04-18T12:00:00.000Z',
      targetPath: 'filters.minLiquidityUsd',
      status: 'supported',
      note: 'Counterfactual evidence supports the same path direction.',
      sampleCount: 5,
      outperformRate: 0.8,
      averageRelativeToSelectedBaselineSol: 0.21,
      recentSliceLabel: 'later-half',
      recentSliceSampleCount: 3,
      recentSliceOutperformRate: 1,
      recentSliceAverageRelativeToSelectedBaselineSol: 0.27
    }
  ];
}
