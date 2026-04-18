import { describe, expect, it } from 'vitest';

import type {
  FilterAnalysisResult,
  OutcomeAnalysisResult,
  OutcomeReviewRecord,
  ParameterProposalRecord
} from '../../../src/evolution';
import { generateEvolutionProposals } from '../../../src/evolution';

describe('generateEvolutionProposals', () => {
  it('emits parameter proposals only for allowlisted YAML paths and converts code suggestions into system proposals', () => {
    const filterAnalysis: FilterAnalysisResult = {
      summary: {
        totalScans: 10,
        totalCandidates: 40,
        selectedCandidateCount: 10,
        filteredCandidateCount: 30,
        blockedReasonCounts: [
          { reason: 'min-liquidity', count: 12 }
        ],
        missedOpportunityCount: 6
      },
      findings: [
        {
          path: 'filters.minLiquidityUsd',
          direction: 'decrease',
          sampleSize: 6,
          confidence: 'medium',
          rationale: 'Filtered candidates later outperformed selected ones.',
          supportingMetric: 0.6
        },
        {
          path: 'selection.weights.liquidity',
          direction: 'decrease',
          sampleSize: 6,
          confidence: 'low',
          rationale: 'Ranking logic appears to overweight liquidity.',
          supportingMetric: 0.4
        }
      ],
      noActionReasons: []
    };
    const outcomeAnalysis: OutcomeAnalysisResult = {
      summary: {
        totalOutcomes: 8,
        matchedFollowThroughCount: 6
      },
      findings: [
        {
          path: 'lpConfig.solDepletionExitBins',
          direction: 'increase',
          sampleSize: 4,
          confidence: 'medium',
          rationale: 'LP exits were followed by continued upside.',
          supportingMetric: 0.5
        }
      ],
      noActionReasons: []
    };

    const result = generateEvolutionProposals({
      strategyId: 'new-token-v1',
      createdAt: '2026-04-18T12:00:00.000Z',
      currentValues: {
        'filters.minLiquidityUsd': 1000,
        'lpConfig.solDepletionExitBins': 60
      },
      filterAnalysis,
      outcomeAnalysis
    });

    expect(result.parameterProposals).toEqual([
      expect.objectContaining({
        proposalKind: 'parameter',
        targetPath: 'filters.minLiquidityUsd',
        oldValue: 1000,
        proposedValue: 900
      }),
      expect.objectContaining({
        proposalKind: 'parameter',
        targetPath: 'lpConfig.solDepletionExitBins',
        oldValue: 60,
        proposedValue: 66
      })
    ]);
    expect(result.systemProposals).toEqual([
      expect.objectContaining({
        proposalKind: 'system',
        targetPath: 'selection.weights.liquidity'
      })
    ]);
  });

  it('returns an explicit no-safe-parameter-proposal result when there are no patchable findings', () => {
    const result = generateEvolutionProposals({
      strategyId: 'new-token-v1',
      createdAt: '2026-04-18T12:00:00.000Z',
      currentValues: {},
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
      }
    });

    expect(result.parameterProposals).toEqual([]);
    expect(result.noActionReasons).toContain('no_safe_parameter_proposal');
  });

  it('suppresses parameter proposals when regime and coverage scoring says the window is not decision-ready', () => {
    const result = generateEvolutionProposals({
      strategyId: 'new-token-v1',
      createdAt: '2026-04-18T12:00:00.000Z',
      currentValues: {
        'filters.minLiquidityUsd': 1000
      },
      filterAnalysis: {
        summary: {
          totalScans: 6,
          totalCandidates: 24,
          selectedCandidateCount: 6,
          filteredCandidateCount: 18,
          blockedReasonCounts: [
            { reason: 'min-liquidity', count: 10 }
          ],
          missedOpportunityCount: 6
        },
        findings: [
          {
            path: 'filters.minLiquidityUsd',
            direction: 'decrease',
            sampleSize: 6,
            confidence: 'high',
            rationale: 'Filtered candidates later outperformed selected ones.',
            supportingMetric: 0.8
          }
        ],
        noActionReasons: []
      },
      outcomeAnalysis: {
        summary: {
          totalOutcomes: 4,
          matchedFollowThroughCount: 1
        },
        findings: [],
        noActionReasons: []
      },
      analysisContext: {
        coverageScore: 0.42,
        regimeScore: 0.48,
        proposalReadinessScore: 0.45,
        regimeLabels: ['thin-follow-through', 'unstable-window'],
        coverageBreakdown: {
          candidateScanCoverage: 0.4,
          watchlistCoverage: 0.45,
          outcomeCoverage: 0.35,
          followThroughCoverage: 0.3
        }
      }
    });

    expect(result.parameterProposals).toEqual([]);
    expect(result.noActionReasons).toContain('data_coverage_gaps');
    expect(result.noActionReasons).toContain('regime_instability');
  });

  it('suppresses repeated weak parameter ideas when the latest review already rejected the same direction', () => {
    const existingProposal: ParameterProposalRecord = {
      proposalId: 'parameter:filters.minLiquidityUsd:2026-04-18T12:00:00.000Z',
      proposalKind: 'parameter',
      strategyId: 'new-token-v1',
      status: 'rejected',
      createdAt: '2026-04-18T12:00:00.000Z',
      updatedAt: '2026-04-19T12:00:00.000Z',
      targetPath: 'filters.minLiquidityUsd',
      oldValue: 1000,
      proposedValue: 900,
      evidenceWindowHours: 24,
      sampleSize: 6,
      rationale: 'Earlier idea.',
      expectedImprovement: 'Earlier expectation.',
      riskNote: 'Earlier risk.',
      uncertaintyNote: 'Earlier uncertainty.',
      patchable: true
    };
    const rejectedReview: OutcomeReviewRecord = {
      proposalId: existingProposal.proposalId,
      status: 'rejected',
      reviewedAt: '2026-04-19T13:00:00.000Z',
      note: 'The lower threshold admitted too much noise.',
      observedMetrics: {
        appliedConfigMatches: true
      }
    };

    const result = generateEvolutionProposals({
      strategyId: 'new-token-v1',
      createdAt: '2026-04-20T12:00:00.000Z',
      currentValues: {
        'filters.minLiquidityUsd': 1000
      },
      filterAnalysis: {
        summary: {
          totalScans: 10,
          totalCandidates: 40,
          selectedCandidateCount: 10,
          filteredCandidateCount: 30,
          blockedReasonCounts: [
            { reason: 'min-liquidity', count: 12 }
          ],
          missedOpportunityCount: 6
        },
        findings: [
          {
            path: 'filters.minLiquidityUsd',
            direction: 'decrease',
            sampleSize: 6,
            confidence: 'medium',
            rationale: 'Filtered candidates later outperformed selected ones.',
            supportingMetric: 0.6
          }
        ],
        noActionReasons: []
      },
      outcomeAnalysis: {
        summary: {
          totalOutcomes: 0,
          matchedFollowThroughCount: 0
        },
        findings: [],
        noActionReasons: []
      },
      existingProposals: [existingProposal],
      outcomeReviews: [rejectedReview]
    });

    expect(result.parameterProposals).toEqual([]);
    expect(result.noActionReasons).toContain('conflicting_evidence');
  });

  it('requires stronger evidence before re-emitting a path that has repeatedly landed in needs_more_data', () => {
    const historicalProposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:filters.minLiquidityUsd:2026-04-16T12:00:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'needs_more_data',
        createdAt: '2026-04-16T12:00:00.000Z',
        updatedAt: '2026-04-17T12:00:00.000Z',
        targetPath: 'filters.minLiquidityUsd',
        oldValue: 1000,
        proposedValue: 900,
        evidenceWindowHours: 24,
        sampleSize: 4,
        rationale: 'Older weak idea.',
        expectedImprovement: 'Older expectation.',
        riskNote: 'Older risk.',
        uncertaintyNote: 'Older uncertainty.',
        analysisConfidence: 'medium',
        supportingMetric: 0.55,
        patchable: true
      },
      {
        proposalId: 'parameter:filters.minLiquidityUsd:2026-04-17T12:00:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'needs_more_data',
        createdAt: '2026-04-17T12:00:00.000Z',
        updatedAt: '2026-04-18T12:00:00.000Z',
        targetPath: 'filters.minLiquidityUsd',
        oldValue: 1000,
        proposedValue: 900,
        evidenceWindowHours: 24,
        sampleSize: 5,
        rationale: 'Second weak idea.',
        expectedImprovement: 'Second expectation.',
        riskNote: 'Second risk.',
        uncertaintyNote: 'Second uncertainty.',
        analysisConfidence: 'medium',
        supportingMetric: 0.56,
        patchable: true
      }
    ];
    const reviews: OutcomeReviewRecord[] = [
      {
        proposalId: historicalProposals[0].proposalId,
        status: 'needs_more_data',
        reviewedAt: '2026-04-17T12:00:00.000Z',
        note: 'Still too thin.',
        observedMetrics: { appliedConfigMatches: true }
      },
      {
        proposalId: historicalProposals[1].proposalId,
        status: 'needs_more_data',
        reviewedAt: '2026-04-18T12:00:00.000Z',
        note: 'Still not enough.',
        observedMetrics: { appliedConfigMatches: true }
      }
    ];

    const weakRepeat = generateEvolutionProposals({
      strategyId: 'new-token-v1',
      createdAt: '2026-04-20T12:00:00.000Z',
      currentValues: {
        'filters.minLiquidityUsd': 1000
      },
      filterAnalysis: {
        summary: {
          totalScans: 10,
          totalCandidates: 40,
          selectedCandidateCount: 10,
          filteredCandidateCount: 30,
          blockedReasonCounts: [{ reason: 'min-liquidity', count: 12 }],
          missedOpportunityCount: 6
        },
        findings: [
          {
            path: 'filters.minLiquidityUsd',
            direction: 'decrease',
            sampleSize: 5,
            confidence: 'medium',
            rationale: 'Still looks somewhat attractive.',
            supportingMetric: 0.57
          }
        ],
        noActionReasons: []
      },
      outcomeAnalysis: {
        summary: {
          totalOutcomes: 0,
          matchedFollowThroughCount: 0
        },
        findings: [],
        noActionReasons: []
      },
      existingProposals: historicalProposals,
      outcomeReviews: reviews
    });

    expect(weakRepeat.parameterProposals).toEqual([]);
    expect(weakRepeat.noActionReasons).toContain('conflicting_evidence');

    const strongerRepeat = generateEvolutionProposals({
      strategyId: 'new-token-v1',
      createdAt: '2026-04-21T12:00:00.000Z',
      currentValues: {
        'filters.minLiquidityUsd': 1000
      },
      filterAnalysis: {
        summary: {
          totalScans: 14,
          totalCandidates: 56,
          selectedCandidateCount: 14,
          filteredCandidateCount: 42,
          blockedReasonCounts: [{ reason: 'min-liquidity', count: 16 }],
          missedOpportunityCount: 9
        },
        findings: [
          {
            path: 'filters.minLiquidityUsd',
            direction: 'decrease',
            sampleSize: 8,
            confidence: 'high',
            rationale: 'Now strongly supported by a larger sample.',
            supportingMetric: 0.72
          }
        ],
        noActionReasons: []
      },
      outcomeAnalysis: {
        summary: {
          totalOutcomes: 0,
          matchedFollowThroughCount: 0
        },
        findings: [],
        noActionReasons: []
      },
      existingProposals: historicalProposals,
      outcomeReviews: reviews
    });

    expect(strongerRepeat.parameterProposals).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        sampleSize: 8
      })
    ]);
  });
});
