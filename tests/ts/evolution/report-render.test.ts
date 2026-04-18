import { describe, expect, it } from 'vitest';

import { renderEvolutionReport } from '../../../src/evolution';

describe('renderEvolutionReport', () => {
  it('renders markdown and JSON artifacts for an evidence-backed report', () => {
    const rendered = renderEvolutionReport({
      strategyId: 'new-token-v1',
      generatedAt: '2026-04-18T12:00:00.000Z',
      evidenceCounts: {
        candidateScans: 12,
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
  });

  it('renders a no-action report when evidence is too thin', () => {
    const rendered = renderEvolutionReport({
      strategyId: 'new-token-v1',
      generatedAt: '2026-04-18T12:00:00.000Z',
      evidenceCounts: {
        candidateScans: 0,
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
      parameterProposals: [],
      systemProposals: [],
      noActionReasons: ['no_safe_parameter_proposal']
    });

    expect(rendered.markdown).toContain('No safe parameter proposals');
    expect(rendered.json.noActionReasons).toContain('no_safe_parameter_proposal');
  });
});
