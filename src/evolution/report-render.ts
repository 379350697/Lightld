import type {
  AnalysisNoActionReason,
  CounterfactualAnalysisResult,
  EvolutionStrategyId,
  ParameterProposalRecord
} from './types.ts';
import type { FilterAnalysisResult } from './filter-analysis.ts';
import type { OutcomeAnalysisResult } from './outcome-analysis.ts';
import type { ProposalValidationRecord } from './proposal-validator.ts';

export type EvolutionReport = {
  strategyId: EvolutionStrategyId;
  generatedAt: string;
  evidenceSnapshot: EvolutionEvidenceSnapshot;
  evidenceCounts: {
    candidateScans: number;
    poolDecisionSamples: number;
    watchlistSnapshots: number;
    outcomes: number;
  };
  filterAnalysis: FilterAnalysisResult;
  outcomeAnalysis: OutcomeAnalysisResult;
  counterfactualAnalysis: CounterfactualAnalysisResult;
  proposalValidations: ProposalValidationRecord[];
  parameterProposals: ParameterProposalRecord[];
  systemProposals: ParameterProposalRecord[];
  noActionReasons: AnalysisNoActionReason[];
};

export type EvolutionEvidenceSnapshot = {
  capturedAt: string;
  timeWindowLabel: string;
  sampleCounts: {
    candidateScans: number;
    poolDecisionSamples: number;
    watchlistSnapshots: number;
    outcomes: number;
  };
  strategyConfigPath: string;
  coverageScore: number;
  regimeScore: number;
  proposalReadinessScore: number;
  coverageBreakdown: {
    candidateScanCoverage: number;
    watchlistCoverage: number;
    outcomeCoverage: number;
    followThroughCoverage: number;
  };
  regimeLabels: string[];
  headlineDiagnostics: string[];
  proposalIds: string[];
};

export function renderEvolutionReport(report: EvolutionReport) {
  const lines = [
    '# Evolution Report',
    '',
    `Strategy: ${report.strategyId}`,
    `Generated at: ${report.generatedAt}`,
    '',
    '## Evidence',
    `Evidence snapshot: ${report.evidenceSnapshot.timeWindowLabel}`,
    `Regime labels: ${report.evidenceSnapshot.regimeLabels.join(', ') || 'none'}`,
    `Coverage score: ${report.evidenceSnapshot.coverageScore.toFixed(2)}`,
    `Regime score: ${report.evidenceSnapshot.regimeScore.toFixed(2)}`,
    `Proposal readiness: ${report.evidenceSnapshot.proposalReadinessScore.toFixed(2)}`,
    `Candidate scans: ${report.evidenceCounts.candidateScans}`,
    `Pool decision samples: ${report.evidenceCounts.poolDecisionSamples}`,
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

  lines.push('## Counterfactual Analysis');
  lines.push(`Eligible counterfactual samples: ${report.counterfactualAnalysis.summary.eligibleCounterfactualSamples}`);
  lines.push(`Positive relative samples: ${report.counterfactualAnalysis.summary.positiveRelativeSamples}`);
  if (report.counterfactualAnalysis.pathSummaries.length > 0) {
    for (const summary of report.counterfactualAnalysis.pathSummaries) {
      const sliceSuffix = summary.sliceSummaries.length > 0
        ? ` slices=${summary.sliceSummaries.map((slice) =>
          `${slice.sliceLabel}:${slice.sampleCount}@${slice.outperformRate.toFixed(2)}/${slice.averageRelativeToSelectedBaselineSol.toFixed(4)}`
        ).join(',')}`
        : '';
      lines.push(
        `- ${summary.targetPath}: ${summary.blockedReason} samples=${summary.sampleCount} outperformRate=${summary.outperformRate.toFixed(2)} avgRelative=${summary.averageRelativeToSelectedBaselineSol.toFixed(4)}${sliceSuffix}`
      );
    }
  }
  lines.push('');

  const supportedValidations = report.proposalValidations.filter((validation) => validation.status === 'supported').length;
  lines.push('## Proposal Validation');
  lines.push(`Supported validations: ${supportedValidations}`);
  if (report.proposalValidations.length > 0) {
    for (const validation of report.proposalValidations) {
      const recentSliceSuffix = validation.recentSliceLabel
        ? ` recent=${validation.recentSliceLabel}:${validation.recentSliceSampleCount}@${(validation.recentSliceOutperformRate ?? 0).toFixed(2)}/${(validation.recentSliceAverageRelativeToSelectedBaselineSol ?? 0).toFixed(4)}`
        : '';
      lines.push(
        `- ${validation.targetPath}: ${validation.status} (${validation.note})${recentSliceSuffix}`
      );
    }
  }
  lines.push('');

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
