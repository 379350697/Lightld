import type {
  AnalysisNoActionReason,
  EvolutionStrategyId,
  ParameterProposalRecord
} from './types.ts';
import type { FilterAnalysisResult } from './filter-analysis.ts';
import type { OutcomeAnalysisResult } from './outcome-analysis.ts';

export type EvolutionReport = {
  strategyId: EvolutionStrategyId;
  generatedAt: string;
  evidenceCounts: {
    candidateScans: number;
    watchlistSnapshots: number;
    outcomes: number;
  };
  filterAnalysis: FilterAnalysisResult;
  outcomeAnalysis: OutcomeAnalysisResult;
  parameterProposals: ParameterProposalRecord[];
  systemProposals: ParameterProposalRecord[];
  noActionReasons: AnalysisNoActionReason[];
};

export function renderEvolutionReport(report: EvolutionReport) {
  const lines = [
    '# Evolution Report',
    '',
    `Strategy: ${report.strategyId}`,
    `Generated at: ${report.generatedAt}`,
    '',
    '## Evidence',
    `Candidate scans: ${report.evidenceCounts.candidateScans}`,
    `Watchlist snapshots: ${report.evidenceCounts.watchlistSnapshots}`,
    `Outcomes: ${report.evidenceCounts.outcomes}`,
    '',
    '## Filter Analysis',
    `Missed opportunities: ${report.filterAnalysis.summary.missedOpportunityCount}`,
    `Blocked reasons: ${report.filterAnalysis.summary.blockedReasonCounts.map((entry) => `${entry.reason}=${entry.count}`).join(', ') || 'none'}`,
    '',
    '## Outcome Analysis',
    `Matched follow-through samples: ${report.outcomeAnalysis.summary.matchedFollowThroughCount}`,
    ''
  ];

  if (report.parameterProposals.length > 0) {
    lines.push('## Parameter Proposals');
    for (const proposal of report.parameterProposals) {
      lines.push(
        `- ${proposal.targetPath}: ${String(proposal.oldValue)} -> ${String(proposal.proposedValue)} (${proposal.rationale})`
      );
    }
    lines.push('');
  }

  if (report.systemProposals.length > 0) {
    lines.push('## System Proposals');
    for (const proposal of report.systemProposals) {
      lines.push(`- ${proposal.targetPath}: ${proposal.rationale}`);
    }
    lines.push('');
  }

  if (report.noActionReasons.length > 0) {
    lines.push('## No-Action Reasons');
    lines.push(`No safe parameter proposals: ${report.noActionReasons.join(', ')}`);
    lines.push('');
  }

  return {
    json: report,
    markdown: lines.join('\n').trim()
  };
}
