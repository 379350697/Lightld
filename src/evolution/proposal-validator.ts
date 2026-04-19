import type { CounterfactualAnalysisResult } from './counterfactual-analyzer.ts';
import type { CounterfactualReplayRecord } from './counterfactual-replay.ts';
import type { OutcomeReplayRecord } from './outcome-replay.ts';
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
  longHorizonWindowLabel: string | null;
  longHorizonWindowSampleCount: number;
  longHorizonWindowOutperformRate: number | null;
  longHorizonWindowAverageRelativeToSelectedBaselineSol: number | null;
  replayAdmittedSampleCount: number;
  replayPositiveRelativeSamples: number;
  replayAverageRelativeToSelectedBaselineSol: number | null;
  replayRecentSliceLabel: string | null;
  replayRecentSliceSampleCount: number;
  replayRecentSliceOutperformRate: number | null;
  replayRecentSliceAverageRelativeToSelectedBaselineSol: number | null;
  replayLongHorizonWindowLabel: string | null;
  replayLongHorizonWindowSampleCount: number;
  replayLongHorizonWindowOutperformRate: number | null;
  replayLongHorizonWindowAverageRelativeToSelectedBaselineSol: number | null;
  outcomeReplayableSampleCount: number;
  outcomeSupportiveSampleCount: number;
  outcomeSupportRate: number | null;
  outcomeAverageHeadroomPct: number | null;
  outcomeRecentWindowLabel: string | null;
  outcomeRecentWindowReplayableSampleCount: number;
  outcomeRecentWindowSupportiveSampleCount: number;
  outcomeRecentWindowSupportRate: number | null;
  outcomeRecentWindowAverageHeadroomPct: number | null;
  outcomeLongHorizonWindowLabel: string | null;
  outcomeLongHorizonWindowReplayableSampleCount: number;
  outcomeLongHorizonWindowSupportiveSampleCount: number;
  outcomeLongHorizonWindowSupportRate: number | null;
  outcomeLongHorizonWindowAverageHeadroomPct: number | null;
  outcomeRecentSliceLabel: string | null;
  outcomeRecentSliceReplayableSampleCount: number;
  outcomeRecentSliceSupportiveSampleCount: number;
  outcomeRecentSliceSupportRate: number | null;
  outcomeRecentSliceAverageHeadroomPct: number | null;
};

export function validateParameterProposals(input: {
  proposals: ParameterProposalRecord[];
  counterfactualAnalysis: CounterfactualAnalysisResult;
  proposalReplays?: CounterfactualReplayRecord[];
  outcomeReplays?: OutcomeReplayRecord[];
}): ProposalValidationRecord[] {
  return input.proposals.map((proposal) => {
    const summary = input.counterfactualAnalysis.pathSummaries.find(
      (pathSummary) => pathSummary.targetPath === proposal.targetPath
    );
    const replay = input.proposalReplays?.find((entry) => entry.proposalId === proposal.proposalId) ?? null;
    const outcomeReplay = input.outcomeReplays?.find((entry) => entry.proposalId === proposal.proposalId) ?? null;

    if (summary === undefined || summary === null) {
      return validateProposalWithoutCounterfactualSummary({
        proposal,
        replay,
        outcomeReplay
      });
    }

    const recentSlice = summary.sliceSummaries.find((slice) => slice.sliceLabel === 'later-half')
      ?? summary.sliceSummaries[summary.sliceSummaries.length - 1]
      ?? null;
    const longHorizonWindow = [...summary.windowSummaries]
      .filter((windowSummary) => parseWindowLabelHours(windowSummary.windowLabel) >= 4)
      .sort((left, right) => parseWindowLabelHours(right.windowLabel) - parseWindowLabelHours(left.windowLabel))[0]
      ?? null;
    const replayRecentSlice = selectRecentReplaySlice(replay);
    const replayLongHorizonWindow = selectLongReplayWindow(replay);
    const hasOverallSupport = summary.sampleCount >= 3
      && summary.outperformRate >= 0.55
      && summary.averageRelativeToSelectedBaselineSol > 0;
    const hasRecentSliceSupport = recentSlice !== null
      && recentSlice.sampleCount >= 2
      && recentSlice.outperformRate >= 0.5
      && recentSlice.averageRelativeToSelectedBaselineSol > 0;
    const hasLongHorizonSupport = longHorizonWindow === null
      || (
        longHorizonWindow.sampleCount >= 2
        && longHorizonWindow.outperformRate >= 0.5
        && longHorizonWindow.averageRelativeToSelectedBaselineSol > 0
      );
    const hasReplayOverallSupport = replay === null
      || (
        replay.admittedSampleCount >= 1
        && replay.positiveRelativeSamples >= 1
        && typeof replay.averageRelativeToSelectedBaselineSol === 'number'
        && replay.averageRelativeToSelectedBaselineSol > 0
      );
    const hasReplayRecentSliceSupport = replay === null
      || replayRecentSlice === null
      || (
        replayRecentSlice.sampleCount >= 1
        && replayRecentSlice.outperformRate >= 0.5
        && replayRecentSlice.averageRelativeToSelectedBaselineSol > 0
      );
    const hasReplayLongHorizonSupport = replay === null
      || replayLongHorizonWindow === null
      || (
        replayLongHorizonWindow.sampleCount >= 1
        && replayLongHorizonWindow.outperformRate >= 0.5
        && replayLongHorizonWindow.averageRelativeToSelectedBaselineSol > 0
      );
    const hasReplaySupport = hasReplayOverallSupport && hasReplayRecentSliceSupport && hasReplayLongHorizonSupport;

    if (hasOverallSupport && hasRecentSliceSupport && hasLongHorizonSupport && hasReplaySupport) {
      return buildValidationRecord({
        proposal,
        replay,
        outcomeReplay,
        status: 'supported',
        note: 'Counterfactual evidence supports the same proposal path with enough sample depth.',
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice.sliceLabel,
        recentSliceSampleCount: recentSlice.sampleCount,
        recentSliceOutperformRate: recentSlice.outperformRate,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice.averageRelativeToSelectedBaselineSol,
        longHorizonWindowLabel: longHorizonWindow?.windowLabel ?? null,
        longHorizonWindowSampleCount: longHorizonWindow?.sampleCount ?? 0,
        longHorizonWindowOutperformRate: longHorizonWindow?.outperformRate ?? null,
        longHorizonWindowAverageRelativeToSelectedBaselineSol:
          longHorizonWindow?.averageRelativeToSelectedBaselineSol ?? null
      });
    }

    if (hasOverallSupport && hasRecentSliceSupport && hasLongHorizonSupport && hasReplayOverallSupport && !hasReplayRecentSliceSupport && replayRecentSlice !== null) {
      return buildValidationRecord({
        proposal,
        replay,
        outcomeReplay,
        status: 'mixed',
        note: `Counterfactual evidence is positive overall, but the replay recent slice (${replayRecentSlice.sliceLabel}) is not holding up yet.`,
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice?.sliceLabel ?? null,
        recentSliceSampleCount: recentSlice?.sampleCount ?? 0,
        recentSliceOutperformRate: recentSlice?.outperformRate ?? null,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice?.averageRelativeToSelectedBaselineSol ?? null,
        longHorizonWindowLabel: longHorizonWindow?.windowLabel ?? null,
        longHorizonWindowSampleCount: longHorizonWindow?.sampleCount ?? 0,
        longHorizonWindowOutperformRate: longHorizonWindow?.outperformRate ?? null,
        longHorizonWindowAverageRelativeToSelectedBaselineSol:
          longHorizonWindow?.averageRelativeToSelectedBaselineSol ?? null
      });
    }

    if (hasOverallSupport && hasRecentSliceSupport && hasLongHorizonSupport && hasReplayOverallSupport && !hasReplayLongHorizonSupport && replayLongHorizonWindow !== null) {
      return buildValidationRecord({
        proposal,
        replay,
        outcomeReplay,
        status: 'mixed',
        note: `Counterfactual evidence is positive overall, but the replay longer-horizon window (${replayLongHorizonWindow.windowLabel}) has not held up yet.`,
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice?.sliceLabel ?? null,
        recentSliceSampleCount: recentSlice?.sampleCount ?? 0,
        recentSliceOutperformRate: recentSlice?.outperformRate ?? null,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice?.averageRelativeToSelectedBaselineSol ?? null,
        longHorizonWindowLabel: longHorizonWindow?.windowLabel ?? null,
        longHorizonWindowSampleCount: longHorizonWindow?.sampleCount ?? 0,
        longHorizonWindowOutperformRate: longHorizonWindow?.outperformRate ?? null,
        longHorizonWindowAverageRelativeToSelectedBaselineSol:
          longHorizonWindow?.averageRelativeToSelectedBaselineSol ?? null
      });
    }

    if (hasOverallSupport && hasRecentSliceSupport && hasLongHorizonSupport && replay !== null) {
      return buildValidationRecord({
        proposal,
        replay,
        outcomeReplay,
        status: 'mixed',
        note: 'Counterfactual evidence looks positive, but replay does not admit enough newly useful samples at the proposed value.',
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice?.sliceLabel ?? null,
        recentSliceSampleCount: recentSlice?.sampleCount ?? 0,
        recentSliceOutperformRate: recentSlice?.outperformRate ?? null,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice?.averageRelativeToSelectedBaselineSol ?? null,
        longHorizonWindowLabel: longHorizonWindow?.windowLabel ?? null,
        longHorizonWindowSampleCount: longHorizonWindow?.sampleCount ?? 0,
        longHorizonWindowOutperformRate: longHorizonWindow?.outperformRate ?? null,
        longHorizonWindowAverageRelativeToSelectedBaselineSol:
          longHorizonWindow?.averageRelativeToSelectedBaselineSol ?? null
      });
    }

    if (hasOverallSupport && hasRecentSliceSupport && longHorizonWindow !== null) {
      return buildValidationRecord({
        proposal,
        replay,
        outcomeReplay,
        status: 'mixed',
        note: `Counterfactual evidence is positive in recent slices, but the longer-horizon window (${longHorizonWindow.windowLabel}) has not held up yet.`,
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice.sliceLabel,
        recentSliceSampleCount: recentSlice.sampleCount,
        recentSliceOutperformRate: recentSlice.outperformRate,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice.averageRelativeToSelectedBaselineSol,
        longHorizonWindowLabel: longHorizonWindow.windowLabel,
        longHorizonWindowSampleCount: longHorizonWindow.sampleCount,
        longHorizonWindowOutperformRate: longHorizonWindow.outperformRate,
        longHorizonWindowAverageRelativeToSelectedBaselineSol:
          longHorizonWindow.averageRelativeToSelectedBaselineSol
      });
    }

    if (hasOverallSupport && recentSlice !== null) {
      return buildValidationRecord({
        proposal,
        replay,
        outcomeReplay,
        status: 'mixed',
        note: `Counterfactual evidence is positive overall, but the recent slice (${recentSlice.sliceLabel}) is not holding up yet.`,
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice.sliceLabel,
        recentSliceSampleCount: recentSlice.sampleCount,
        recentSliceOutperformRate: recentSlice.outperformRate,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice.averageRelativeToSelectedBaselineSol,
        longHorizonWindowLabel: longHorizonWindow?.windowLabel ?? null,
        longHorizonWindowSampleCount: longHorizonWindow?.sampleCount ?? 0,
        longHorizonWindowOutperformRate: longHorizonWindow?.outperformRate ?? null,
        longHorizonWindowAverageRelativeToSelectedBaselineSol:
          longHorizonWindow?.averageRelativeToSelectedBaselineSol ?? null
      });
    }

    if (summary.outperformRate > 0 || summary.averageRelativeToSelectedBaselineSol > 0) {
      return buildValidationRecord({
        proposal,
        replay,
        outcomeReplay,
        status: 'mixed',
        note: 'Counterfactual evidence is directionally positive but still too thin or inconsistent.',
        sampleCount: summary.sampleCount,
        outperformRate: summary.outperformRate,
        averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
        recentSliceLabel: recentSlice?.sliceLabel ?? null,
        recentSliceSampleCount: recentSlice?.sampleCount ?? 0,
        recentSliceOutperformRate: recentSlice?.outperformRate ?? null,
        recentSliceAverageRelativeToSelectedBaselineSol: recentSlice?.averageRelativeToSelectedBaselineSol ?? null,
        longHorizonWindowLabel: longHorizonWindow?.windowLabel ?? null,
        longHorizonWindowSampleCount: longHorizonWindow?.sampleCount ?? 0,
        longHorizonWindowOutperformRate: longHorizonWindow?.outperformRate ?? null,
        longHorizonWindowAverageRelativeToSelectedBaselineSol:
          longHorizonWindow?.averageRelativeToSelectedBaselineSol ?? null
      });
    }

    return buildValidationRecord({
      proposal,
      replay,
      outcomeReplay,
      status: 'insufficient_evidence',
      note: 'Counterfactual evidence does not yet support this proposal path strongly enough.',
      sampleCount: summary.sampleCount,
      outperformRate: summary.outperformRate,
      averageRelativeToSelectedBaselineSol: summary.averageRelativeToSelectedBaselineSol,
      recentSliceLabel: recentSlice?.sliceLabel ?? null,
      recentSliceSampleCount: recentSlice?.sampleCount ?? 0,
      recentSliceOutperformRate: recentSlice?.outperformRate ?? null,
      recentSliceAverageRelativeToSelectedBaselineSol: recentSlice?.averageRelativeToSelectedBaselineSol ?? null,
      longHorizonWindowLabel: longHorizonWindow?.windowLabel ?? null,
      longHorizonWindowSampleCount: longHorizonWindow?.sampleCount ?? 0,
      longHorizonWindowOutperformRate: longHorizonWindow?.outperformRate ?? null,
      longHorizonWindowAverageRelativeToSelectedBaselineSol:
        longHorizonWindow?.averageRelativeToSelectedBaselineSol ?? null
    });
  });
}

function validateProposalWithoutCounterfactualSummary(input: {
  proposal: ParameterProposalRecord;
  replay: CounterfactualReplayRecord | null;
  outcomeReplay: OutcomeReplayRecord | null;
}): ProposalValidationRecord {
  const { proposal, replay, outcomeReplay } = input;
  const recentOutcomeWindow = selectRecentOutcomeWindow(outcomeReplay);
  const longOutcomeWindow = selectLongOutcomeWindow(outcomeReplay);
  const recentOutcomeSlice = selectRecentOutcomeSlice(outcomeReplay);
  const hasOutcomeReplayOverallSupport = outcomeReplay !== null
    && outcomeReplay.replayableSampleCount >= 2
    && outcomeReplay.supportiveSampleCount >= 1
    && outcomeReplay.supportRate >= 0.5
    && typeof outcomeReplay.averageHeadroomPct === 'number'
    && outcomeReplay.averageHeadroomPct > 0;
  const hasOutcomeRecentWindowSupport = recentOutcomeWindow === null
    || (
      recentOutcomeWindow.replayableSampleCount >= 1
      && recentOutcomeWindow.supportRate >= 0.5
      && typeof recentOutcomeWindow.averageHeadroomPct === 'number'
      && recentOutcomeWindow.averageHeadroomPct > 0
    );
  const hasOutcomeLongWindowSupport = longOutcomeWindow === null
    || (
      longOutcomeWindow.replayableSampleCount >= 1
      && longOutcomeWindow.supportRate >= 0.5
      && typeof longOutcomeWindow.averageHeadroomPct === 'number'
      && longOutcomeWindow.averageHeadroomPct > 0
    );
  const shouldEnforceOutcomeRecentSlice = outcomeReplay !== null
    && outcomeReplay.replayableSampleCount >= 4
    && outcomeReplay.sliceSummaries.length > 1;
  const hasOutcomeRecentSliceSupport = !shouldEnforceOutcomeRecentSlice
    || recentOutcomeSlice === null
    || (
      recentOutcomeSlice.replayableSampleCount >= 1
      && recentOutcomeSlice.supportRate >= 0.5
      && typeof recentOutcomeSlice.averageHeadroomPct === 'number'
      && recentOutcomeSlice.averageHeadroomPct > 0
    );

  if (hasOutcomeReplayOverallSupport && hasOutcomeRecentWindowSupport && hasOutcomeLongWindowSupport && hasOutcomeRecentSliceSupport) {
    return buildValidationRecord({
      proposal,
      replay,
      outcomeReplay,
      status: 'supported',
      note: 'No filter-side counterfactual summary exists yet, but outcome replay shows enough post-exit follow-through for this parameter direction.',
      sampleCount: 0,
      outperformRate: null,
      averageRelativeToSelectedBaselineSol: null,
      recentSliceLabel: null,
      recentSliceSampleCount: 0,
      recentSliceOutperformRate: null,
      recentSliceAverageRelativeToSelectedBaselineSol: null,
      longHorizonWindowLabel: null,
      longHorizonWindowSampleCount: 0,
      longHorizonWindowOutperformRate: null,
      longHorizonWindowAverageRelativeToSelectedBaselineSol: null
    });
  }

  if (hasOutcomeReplayOverallSupport && hasOutcomeRecentWindowSupport && hasOutcomeLongWindowSupport && shouldEnforceOutcomeRecentSlice && recentOutcomeSlice !== null) {
    return buildValidationRecord({
      proposal,
      replay,
      outcomeReplay,
      status: 'mixed',
      note: `Outcome replay is directionally positive, but the recent post-exit slice (${recentOutcomeSlice.sliceLabel}) is not holding up yet.`,
      sampleCount: 0,
      outperformRate: null,
      averageRelativeToSelectedBaselineSol: null,
      recentSliceLabel: null,
      recentSliceSampleCount: 0,
      recentSliceOutperformRate: null,
      recentSliceAverageRelativeToSelectedBaselineSol: null,
      longHorizonWindowLabel: null,
      longHorizonWindowSampleCount: 0,
      longHorizonWindowOutperformRate: null,
      longHorizonWindowAverageRelativeToSelectedBaselineSol: null
    });
  }

  if (hasOutcomeReplayOverallSupport && hasOutcomeRecentWindowSupport && longOutcomeWindow !== null) {
    return buildValidationRecord({
      proposal,
      replay,
      outcomeReplay,
      status: 'mixed',
      note: `Outcome replay is positive in shorter windows, but the longer-horizon window (${longOutcomeWindow.windowLabel}) has not held up yet.`,
      sampleCount: 0,
      outperformRate: null,
      averageRelativeToSelectedBaselineSol: null,
      recentSliceLabel: null,
      recentSliceSampleCount: 0,
      recentSliceOutperformRate: null,
      recentSliceAverageRelativeToSelectedBaselineSol: null,
      longHorizonWindowLabel: null,
      longHorizonWindowSampleCount: 0,
      longHorizonWindowOutperformRate: null,
      longHorizonWindowAverageRelativeToSelectedBaselineSol: null
    });
  }

  return buildValidationRecord({
    proposal,
    replay,
    outcomeReplay,
    status: 'insufficient_evidence',
    note: 'No matching counterfactual summary exists for this proposal path yet.',
    sampleCount: 0,
    outperformRate: null,
    averageRelativeToSelectedBaselineSol: null,
    recentSliceLabel: null,
    recentSliceSampleCount: 0,
    recentSliceOutperformRate: null,
    recentSliceAverageRelativeToSelectedBaselineSol: null,
    longHorizonWindowLabel: null,
    longHorizonWindowSampleCount: 0,
    longHorizonWindowOutperformRate: null,
    longHorizonWindowAverageRelativeToSelectedBaselineSol: null
  });
}

function buildValidationRecord(input: {
  proposal: ParameterProposalRecord;
  replay: CounterfactualReplayRecord | null;
  outcomeReplay: OutcomeReplayRecord | null;
  status: ProposalValidationStatus;
  note: string;
  sampleCount: number;
  outperformRate: number | null;
  averageRelativeToSelectedBaselineSol: number | null;
  recentSliceLabel: string | null;
  recentSliceSampleCount: number;
  recentSliceOutperformRate: number | null;
  recentSliceAverageRelativeToSelectedBaselineSol: number | null;
  longHorizonWindowLabel: string | null;
  longHorizonWindowSampleCount: number;
  longHorizonWindowOutperformRate: number | null;
  longHorizonWindowAverageRelativeToSelectedBaselineSol: number | null;
}): ProposalValidationRecord {
  return {
    proposalId: input.proposal.proposalId,
    targetPath: input.proposal.targetPath,
    status: input.status,
    note: input.note,
    sampleCount: input.sampleCount,
    outperformRate: input.outperformRate,
    averageRelativeToSelectedBaselineSol: input.averageRelativeToSelectedBaselineSol,
    recentSliceLabel: input.recentSliceLabel,
    recentSliceSampleCount: input.recentSliceSampleCount,
    recentSliceOutperformRate: input.recentSliceOutperformRate,
    recentSliceAverageRelativeToSelectedBaselineSol: input.recentSliceAverageRelativeToSelectedBaselineSol,
    longHorizonWindowLabel: input.longHorizonWindowLabel,
    longHorizonWindowSampleCount: input.longHorizonWindowSampleCount,
    longHorizonWindowOutperformRate: input.longHorizonWindowOutperformRate,
    longHorizonWindowAverageRelativeToSelectedBaselineSol: input.longHorizonWindowAverageRelativeToSelectedBaselineSol,
    replayAdmittedSampleCount: input.replay?.admittedSampleCount ?? 0,
    replayPositiveRelativeSamples: input.replay?.positiveRelativeSamples ?? 0,
    replayAverageRelativeToSelectedBaselineSol: input.replay?.averageRelativeToSelectedBaselineSol ?? null,
    replayRecentSliceLabel: selectRecentReplaySlice(input.replay)?.sliceLabel ?? null,
    replayRecentSliceSampleCount: selectRecentReplaySlice(input.replay)?.sampleCount ?? 0,
    replayRecentSliceOutperformRate: selectRecentReplaySlice(input.replay)?.outperformRate ?? null,
    replayRecentSliceAverageRelativeToSelectedBaselineSol:
      selectRecentReplaySlice(input.replay)?.averageRelativeToSelectedBaselineSol ?? null,
    replayLongHorizonWindowLabel: selectLongReplayWindow(input.replay)?.windowLabel ?? null,
    replayLongHorizonWindowSampleCount: selectLongReplayWindow(input.replay)?.sampleCount ?? 0,
    replayLongHorizonWindowOutperformRate: selectLongReplayWindow(input.replay)?.outperformRate ?? null,
    replayLongHorizonWindowAverageRelativeToSelectedBaselineSol:
      selectLongReplayWindow(input.replay)?.averageRelativeToSelectedBaselineSol ?? null,
    outcomeReplayableSampleCount: input.outcomeReplay?.replayableSampleCount ?? 0,
    outcomeSupportiveSampleCount: input.outcomeReplay?.supportiveSampleCount ?? 0,
    outcomeSupportRate: input.outcomeReplay?.supportRate ?? null,
    outcomeAverageHeadroomPct: input.outcomeReplay?.averageHeadroomPct ?? null,
    outcomeRecentWindowLabel: selectRecentOutcomeWindow(input.outcomeReplay)?.windowLabel ?? null,
    outcomeRecentWindowReplayableSampleCount: selectRecentOutcomeWindow(input.outcomeReplay)?.replayableSampleCount ?? 0,
    outcomeRecentWindowSupportiveSampleCount: selectRecentOutcomeWindow(input.outcomeReplay)?.supportiveSampleCount ?? 0,
    outcomeRecentWindowSupportRate: selectRecentOutcomeWindow(input.outcomeReplay)?.supportRate ?? null,
    outcomeRecentWindowAverageHeadroomPct: selectRecentOutcomeWindow(input.outcomeReplay)?.averageHeadroomPct ?? null,
    outcomeLongHorizonWindowLabel: selectLongOutcomeWindow(input.outcomeReplay)?.windowLabel ?? null,
    outcomeLongHorizonWindowReplayableSampleCount:
      selectLongOutcomeWindow(input.outcomeReplay)?.replayableSampleCount ?? 0,
    outcomeLongHorizonWindowSupportiveSampleCount:
      selectLongOutcomeWindow(input.outcomeReplay)?.supportiveSampleCount ?? 0,
    outcomeLongHorizonWindowSupportRate: selectLongOutcomeWindow(input.outcomeReplay)?.supportRate ?? null,
    outcomeLongHorizonWindowAverageHeadroomPct:
      selectLongOutcomeWindow(input.outcomeReplay)?.averageHeadroomPct ?? null,
    outcomeRecentSliceLabel: selectRecentOutcomeSlice(input.outcomeReplay)?.sliceLabel ?? null,
    outcomeRecentSliceReplayableSampleCount: selectRecentOutcomeSlice(input.outcomeReplay)?.replayableSampleCount ?? 0,
    outcomeRecentSliceSupportiveSampleCount: selectRecentOutcomeSlice(input.outcomeReplay)?.supportiveSampleCount ?? 0,
    outcomeRecentSliceSupportRate: selectRecentOutcomeSlice(input.outcomeReplay)?.supportRate ?? null,
    outcomeRecentSliceAverageHeadroomPct:
      selectRecentOutcomeSlice(input.outcomeReplay)?.averageHeadroomPct ?? null
  };
}

function parseWindowLabelHours(windowLabel: string) {
  const trimmed = windowLabel.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(m|h|d)$/);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (unit === 'm') {
    return value / 60;
  }

  if (unit === 'd') {
    return value * 24;
  }

  return value;
}

function selectRecentOutcomeWindow(outcomeReplay: OutcomeReplayRecord | null) {
  if (!outcomeReplay || outcomeReplay.windowSummaries.length === 0) {
    return null;
  }

  return [...outcomeReplay.windowSummaries]
    .sort((left, right) => parseWindowLabelHours(left.windowLabel) - parseWindowLabelHours(right.windowLabel))[0]
    ?? null;
}

function selectLongOutcomeWindow(outcomeReplay: OutcomeReplayRecord | null) {
  if (!outcomeReplay || outcomeReplay.windowSummaries.length === 0) {
    return null;
  }

  return [...outcomeReplay.windowSummaries]
    .sort((left, right) => parseWindowLabelHours(right.windowLabel) - parseWindowLabelHours(left.windowLabel))[0]
    ?? null;
}

function selectRecentReplaySlice(replay: CounterfactualReplayRecord | null) {
  if (!replay || replay.sliceSummaries.length === 0) {
    return null;
  }

  return replay.sliceSummaries.find((slice) => slice.sliceLabel === 'later-half')
    ?? replay.sliceSummaries[replay.sliceSummaries.length - 1]
    ?? null;
}

function selectLongReplayWindow(replay: CounterfactualReplayRecord | null) {
  if (!replay || replay.windowSummaries.length === 0) {
    return null;
  }

  return [...replay.windowSummaries]
    .sort((left, right) => parseWindowLabelHours(right.windowLabel) - parseWindowLabelHours(left.windowLabel))[0]
    ?? null;
}

function selectRecentOutcomeSlice(outcomeReplay: OutcomeReplayRecord | null) {
  if (!outcomeReplay || outcomeReplay.sliceSummaries.length === 0) {
    return null;
  }

  return outcomeReplay.sliceSummaries.find((slice) => slice.sliceLabel === 'later-half')
    ?? outcomeReplay.sliceSummaries[outcomeReplay.sliceSummaries.length - 1]
    ?? null;
}
