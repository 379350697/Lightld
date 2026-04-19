import type { CounterfactualAnalysisResult } from './counterfactual-analyzer.ts';
import type { ParameterProposalRecord } from './types.ts';

export type ProposalValidationStatus = 'supported' | 'mixed' | 'insufficient_evidence';

export type ProposalValidationRecord = {
  proposalId: string;
  targetPath: string;
  status: ProposalValidationStatus;
  note: string;
  sampleCount: number;
  outperformRate: number | null;
  averageRelativeToSelectedBaselineSol: number | null;
  recentSliceLabel: string | null;
  recentSliceSampleCount: number;
  recentSliceOutperformRate: number | null;
  recentSliceAverageRelativeToSelectedBaselineSol: number | null;
};

export function validateParameterProposals(input: {
  proposals: ParameterProposalRecord[];
  counterfactualAnalysis: CounterfactualAnalysisResult;
}): ProposalValidationRecord[] {
  return input.proposals.map((proposal) => {
    const summary = input.counterfactualAnalysis.pathSummaries.find(
      (pathSummary) => pathSummary.targetPath === proposal.targetPath
    );

    if (!summary) {
      return {
        proposalId: proposal.proposalId,
        targetPath: proposal.targetPath,
        status: 'insufficient_evidence',
        note: 'No matching counterfactual summary exists for this proposal path yet.',
        sampleCount: 0,
        outperformRate: null,
        averageRelativeToSelectedBaselineSol: null,
        recentSliceLabel: null,
        recentSliceSampleCount: 0,
        recentSliceOutperformRate: null,
        recentSliceAverageRelativeToSelectedBaselineSol: null
      };
    }

    const recentSlice = summary.sliceSummaries.find((slice) => slice.sliceLabel === 'later-half')
      ?? summary.sliceSummaries[summary.sliceSummaries.length - 1]
      ?? null;
    const hasOverallSupport = summary.sampleCount >= 3
      && summary.outperformRate >= 0.55
      && summary.averageRelativeToSelectedBaselineSol > 0;
    const hasRecentSliceSupport = recentSlice !== null
      && recentSlice.sampleCount >= 2
      && recentSlice.outperformRate >= 0.5
      && recentSlice.averageRelativeToSelectedBaselineSol > 0;

    if (hasOverallSupport && hasRecentSliceSupport) {
      return {
        proposalId: proposal.proposalId,
        targetPath: proposal.targetPath,
        status: 'supported',
        note: 'Counterfactual evidence supports the same proposal path with enough sample depth.',
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice.sliceLabel,
        recentSliceSampleCount: recentSlice.sampleCount,
        recentSliceOutperformRate: recentSlice.outperformRate,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice.averageRelativeToSelectedBaselineSol
      };
    }

    if (hasOverallSupport && recentSlice !== null) {
      return {
        proposalId: proposal.proposalId,
        targetPath: proposal.targetPath,
        status: 'mixed',
        note: `Counterfactual evidence is positive overall, but the recent slice (${recentSlice.sliceLabel}) is not holding up yet.`,
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice.sliceLabel,
        recentSliceSampleCount: recentSlice.sampleCount,
        recentSliceOutperformRate: recentSlice.outperformRate,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice.averageRelativeToSelectedBaselineSol
      };
    }

    if (summary.outperformRate > 0 || summary.averageRelativeToSelectedBaselineSol > 0) {
      return {
        proposalId: proposal.proposalId,
        targetPath: proposal.targetPath,
        status: 'mixed',
        note: 'Counterfactual evidence is directionally positive but still too thin or inconsistent.',
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice?.sliceLabel ?? null,
        recentSliceSampleCount: recentSlice?.sampleCount ?? 0,
        recentSliceOutperformRate: recentSlice?.outperformRate ?? null,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice?.averageRelativeToSelectedBaselineSol ?? null
      };
    }

    return {
      proposalId: proposal.proposalId,
      targetPath: proposal.targetPath,
      status: 'insufficient_evidence',
      note: 'Counterfactual evidence does not yet support this proposal path strongly enough.',
      sampleCount: summary.sampleCount,
      outperformRate: summary.outperformRate,
      averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
      recentSliceLabel: recentSlice?.sliceLabel ?? null,
      recentSliceSampleCount: recentSlice?.sampleCount ?? 0,
      recentSliceOutperformRate: recentSlice?.outperformRate ?? null,
      recentSliceAverageRelativeToSelectedBaselineSol: recentSlice?.averageRelativeToSelectedBaselineSol ?? null
    };
  });
}
