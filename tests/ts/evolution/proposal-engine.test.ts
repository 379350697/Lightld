import { describe, expect, it } from 'vitest';

import type { FilterAnalysisResult, OutcomeAnalysisResult } from '../../../src/evolution';
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
});
