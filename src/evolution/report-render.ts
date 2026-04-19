import type {
  AnalysisNoActionReason,
  CounterfactualAnalysisResult,
  EvolutionStrategyId,
  ParameterProposalRecord
} from './types.ts';
import type { CounterfactualReplayRecord } from './counterfactual-replay.ts';
import type { FilterAnalysisResult } from './filter-analysis.ts';
import type { OutcomeAnalysisResult } from './outcome-analysis.ts';
import type { OutcomeReplayRecord } from './outcome-replay.ts';
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
  proposalReplays: CounterfactualReplayRecord[];
  outcomeReplays: OutcomeReplayRecord[];
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
      const windowSuffix = summary.windowSummaries.length > 0
        ? ` windows=${summary.windowSummaries.map((windowSummary) =>
          `${windowSummary.windowLabel}:${windowSummary.sampleCount}@${windowSummary.outperformRate.toFixed(2)}/${windowSummary.averageRelativeToSelectedBaselineSol.toFixed(4)}`
        ).join(',')}`
        : '';
      lines.push(
        `- ${summary.targetPath}: ${summary.blockedReason} samples=${summary.sampleCount} outperformRate=${summary.outperformRate.toFixed(2)} avgRelative=${summary.averageRelativeToSelectedBaselineSol.toFixed(4)}${windowSuffix}${sliceSuffix}`
      );
    }
  }
  lines.push('');

  lines.push('## Proposal Replay');
  const totalReplayAdmissions = report.proposalReplays.reduce((sum, replay) => sum + replay.admittedSampleCount, 0);
  lines.push(`Replay admitted samples: ${totalReplayAdmissions}`);
  if (report.proposalReplays.length > 0) {
    for (const replay of report.proposalReplays) {
      const replayWindowSuffix = replay.windowSummaries.length > 0
        ? ` windows=${replay.windowSummaries.map((windowSummary) =>
          `${windowSummary.windowLabel}:${windowSummary.sampleCount}@${windowSummary.outperformRate.toFixed(2)}/${windowSummary.averageRelativeToSelectedBaselineSol.toFixed(4)}`
        ).join(',')}`
        : '';
      const replaySliceSuffix = replay.sliceSummaries.length > 0
        ? ` slices=${replay.sliceSummaries.map((sliceSummary) =>
          `${sliceSummary.sliceLabel}:${sliceSummary.sampleCount}@${sliceSummary.outperformRate.toFixed(2)}/${sliceSummary.averageRelativeToSelectedBaselineSol.toFixed(4)}`
        ).join(',')}`
        : '';
      lines.push(
        `- ${replay.targetPath}: admitted=${replay.admittedSampleCount} positive=${replay.positiveRelativeSamples} avgRelative=${typeof replay.averageRelativeToSelectedBaselineSol === 'number' ? replay.averageRelativeToSelectedBaselineSol.toFixed(4) : 'n/a'}${replayWindowSuffix}${replaySliceSuffix}`
      );
    }
  }
  lines.push('');

  lines.push('## Outcome Replay');
  const totalOutcomeReplaySamples = report.outcomeReplays.reduce((sum, replay) => sum + replay.replayableSampleCount, 0);
  lines.push(`Outcome replayable samples: ${totalOutcomeReplaySamples}`);
  if (report.outcomeReplays.length > 0) {
    for (const replay of report.outcomeReplays) {
      const outcomeWindowSuffix = replay.windowSummaries.length > 0
        ? ` windows=${replay.windowSummaries.map((windowSummary) =>
          `${windowSummary.windowLabel}:${windowSummary.replayableSampleCount}/${windowSummary.supportiveSampleCount}@${windowSummary.supportRate.toFixed(2)}/${typeof windowSummary.averageHeadroomPct === 'number' ? windowSummary.averageHeadroomPct.toFixed(4) : 'n/a'}`
        ).join(',')}`
        : '';
      const outcomeSliceSuffix = replay.sliceSummaries.length > 0
        ? ` slices=${replay.sliceSummaries.map((sliceSummary) =>
          `${sliceSummary.sliceLabel}:${sliceSummary.replayableSampleCount}/${sliceSummary.supportiveSampleCount}@${sliceSummary.supportRate.toFixed(2)}/${typeof sliceSummary.averageHeadroomPct === 'number' ? sliceSummary.averageHeadroomPct.toFixed(4) : 'n/a'}`
        ).join(',')}`
        : '';
      lines.push(
        `- ${replay.targetPath}: replayable=${replay.replayableSampleCount} supportive=${replay.supportiveSampleCount} supportRate=${replay.supportRate.toFixed(2)} avgHeadroom=${typeof replay.averageHeadroomPct === 'number' ? replay.averageHeadroomPct.toFixed(4) : 'n/a'}${outcomeWindowSuffix}${outcomeSliceSuffix}`
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
      const longHorizonSuffix = validation.longHorizonWindowLabel
        ? ` long=${validation.longHorizonWindowLabel}:${validation.longHorizonWindowSampleCount}@${(validation.longHorizonWindowOutperformRate ?? 0).toFixed(2)}/${(validation.longHorizonWindowAverageRelativeToSelectedBaselineSol ?? 0).toFixed(4)}`
        : '';
      const replaySuffix = validation.replayAdmittedSampleCount > 0 || validation.replayAverageRelativeToSelectedBaselineSol !== null
        ? ` replay=${validation.replayAdmittedSampleCount}/${validation.replayPositiveRelativeSamples}@${(validation.replayAverageRelativeToSelectedBaselineSol ?? 0).toFixed(4)}`
        : '';
      const replayWindowSuffix = validation.replayLongHorizonWindowLabel
        ? ` replayWindows=${validation.replayLongHorizonWindowLabel}:${validation.replayLongHorizonWindowSampleCount}@${(validation.replayLongHorizonWindowOutperformRate ?? 0).toFixed(2)}/${(validation.replayLongHorizonWindowAverageRelativeToSelectedBaselineSol ?? 0).toFixed(4)}`
        : '';
      const replaySliceSuffix = validation.replayRecentSliceLabel
        ? ` replaySlices=${validation.replayRecentSliceLabel}:${validation.replayRecentSliceSampleCount}@${(validation.replayRecentSliceOutperformRate ?? 0).toFixed(2)}/${(validation.replayRecentSliceAverageRelativeToSelectedBaselineSol ?? 0).toFixed(4)}`
        : '';
      const outcomeReplaySuffix = validation.outcomeReplayableSampleCount > 0 || validation.outcomeAverageHeadroomPct !== null
        ? ` outcomeReplay=${validation.outcomeReplayableSampleCount}/${validation.outcomeSupportiveSampleCount}@${(validation.outcomeSupportRate ?? 0).toFixed(2)}/${(validation.outcomeAverageHeadroomPct ?? 0).toFixed(4)}`
        : '';
      const outcomeWindowSuffix = validation.outcomeRecentWindowLabel || validation.outcomeLongHorizonWindowLabel
        ? ` outcomeWindows=${validation.outcomeRecentWindowLabel
            ? `${validation.outcomeRecentWindowLabel}:${validation.outcomeRecentWindowReplayableSampleCount}/${validation.outcomeRecentWindowSupportiveSampleCount}@${(validation.outcomeRecentWindowSupportRate ?? 0).toFixed(2)}/${(validation.outcomeRecentWindowAverageHeadroomPct ?? 0).toFixed(4)}`
            : 'none'}${validation.outcomeLongHorizonWindowLabel
            ? `,${validation.outcomeLongHorizonWindowLabel}:${validation.outcomeLongHorizonWindowReplayableSampleCount}/${validation.outcomeLongHorizonWindowSupportiveSampleCount}@${(validation.outcomeLongHorizonWindowSupportRate ?? 0).toFixed(2)}/${(validation.outcomeLongHorizonWindowAverageHeadroomPct ?? 0).toFixed(4)}`
            : ''}`
        : '';
      const outcomeSliceSuffix = validation.outcomeRecentSliceLabel
        ? ` outcomeSlices=${validation.outcomeRecentSliceLabel}:${validation.outcomeRecentSliceReplayableSampleCount}/${validation.outcomeRecentSliceSupportiveSampleCount}@${(validation.outcomeRecentSliceSupportRate ?? 0).toFixed(2)}/${(validation.outcomeRecentSliceAverageHeadroomPct ?? 0).toFixed(4)}`
        : '';
      lines.push(
        `- ${validation.targetPath}: ${validation.status} (${validation.note})${recentSliceSuffix}${longHorizonSuffix}${replaySuffix}${replayWindowSuffix}${replaySliceSuffix}${outcomeReplaySuffix}${outcomeWindowSuffix}${outcomeSliceSuffix}`
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
