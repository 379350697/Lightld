import type {
  LiveCycleOutcomeRecord,
  ParameterProposalRecord,
  WatchlistSnapshotRecord
} from './types.ts';

export type OutcomeReplayRecord = {
  proposalId: string;
  targetPath: string;
  replayableSampleCount: number;
  supportiveSampleCount: number;
  supportRate: number;
  averageHeadroomPct: number | null;
  windowSummaries: OutcomeReplayWindowSummary[];
  sliceSummaries: OutcomeReplaySliceSummary[];
};

export type OutcomeReplayWindowSummary = {
  windowLabel: string;
  replayableSampleCount: number;
  supportiveSampleCount: number;
  supportRate: number;
  averageHeadroomPct: number | null;
};

export type OutcomeReplaySliceSummary = {
  sliceLabel: string;
  replayableSampleCount: number;
  supportiveSampleCount: number;
  supportRate: number;
  averageHeadroomPct: number | null;
};

export function replayOutcomeProposals(input: {
  proposals: ParameterProposalRecord[];
  outcomes: LiveCycleOutcomeRecord[];
  watchlistSnapshots?: WatchlistSnapshotRecord[];
}): OutcomeReplayRecord[] {
  return input.proposals.map((proposal) => {
    const oldValue = typeof proposal.oldValue === 'number' ? proposal.oldValue : null;
    const proposedValue = typeof proposal.proposedValue === 'number' ? proposal.proposedValue : null;
    if (oldValue === null || proposedValue === null) {
      return emptyReplay(proposal);
    }

    const replayableOutcomes = resolveReplayableOutcomes({
      proposal,
      oldValue,
      proposedValue,
      outcomes: input.outcomes,
      watchlistSnapshots: input.watchlistSnapshots ?? []
    });
    if (replayableOutcomes === null) {
      return emptyReplay(proposal);
    }

    const supportiveOutcomes = replayableOutcomes.filter((outcome) => outcome.supportive);
    const headrooms = supportiveOutcomes
      .map((outcome) => roundMetric(outcome.headroomPct))
      .filter((value): value is number => typeof value === 'number');

    return {
      proposalId: proposal.proposalId,
      targetPath: proposal.targetPath,
      replayableSampleCount: replayableOutcomes.length,
      supportiveSampleCount: supportiveOutcomes.length,
      supportRate: replayableOutcomes.length > 0
        ? roundMetric(supportiveOutcomes.length / replayableOutcomes.length)
        : 0,
      averageHeadroomPct: headrooms.length > 0
        ? roundMetric(headrooms.reduce((sum, value) => sum + value, 0) / headrooms.length)
        : null,
      windowSummaries: buildWindowSummaries(replayableOutcomes),
      sliceSummaries: buildSliceSummaries(replayableOutcomes)
    };
  });
}

function resolveReplayableOutcomes(input: {
  proposal: ParameterProposalRecord;
  oldValue: number;
  proposedValue: number;
  outcomes: LiveCycleOutcomeRecord[];
  watchlistSnapshots: WatchlistSnapshotRecord[];
}): Array<{ supportive: boolean; headroomPct: number; windowLabel?: string; observedAt?: string }> | null {
  const { proposal, oldValue, proposedValue, outcomes, watchlistSnapshots } = input;

  if (proposal.targetPath === 'riskThresholds.takeProfitPct' && proposedValue > oldValue) {
    return outcomes.flatMap((outcome) => {
      if (
        !outcome.actualExitReason.includes('take-profit')
        || typeof outcome.takeProfitPctAtEntry !== 'number'
        || typeof outcome.maxObservedUpsidePct !== 'number'
        || outcome.takeProfitPctAtEntry !== oldValue
      ) {
        return [];
      }

      return [{
        supportive: outcome.maxObservedUpsidePct >= proposedValue,
        headroomPct: outcome.maxObservedUpsidePct - proposedValue,
        observedAt: outcome.closedAt ?? outcome.recordedAt
      }];
    });
  }

  if (proposal.targetPath === 'lpConfig.takeProfitNetPnlPct' && proposedValue > oldValue) {
    return outcomes.flatMap((outcome) => {
      if (
        !outcome.actualExitReason.includes('lp-take-profit')
        || typeof outcome.lpTakeProfitNetPnlPctAtEntry !== 'number'
        || typeof outcome.actualExitMetricValue !== 'number'
        || outcome.lpTakeProfitNetPnlPctAtEntry !== oldValue
      ) {
        return [];
      }

      return [{
        supportive: outcome.actualExitMetricValue >= proposedValue,
        headroomPct: outcome.actualExitMetricValue - proposedValue,
        observedAt: outcome.closedAt ?? outcome.recordedAt
      }];
    });
  }

  if (proposal.targetPath === 'riskThresholds.stopLossPct' && proposedValue < oldValue) {
    return outcomes.flatMap((outcome) => {
      const snapshots = findSnapshotsAfterExit({
        tokenMint: outcome.tokenMint,
        closedAt: outcome.closedAt,
        watchlistSnapshots
      });
      const exitValue = outcome.exitMetrics.quoteOutputSol;
      if (
        !outcome.actualExitReason.includes('stop-loss')
        || outcome.actualExitReason.includes('lp-stop-loss')
        || typeof outcome.stopLossPctAtEntry !== 'number'
        || outcome.stopLossPctAtEntry !== oldValue
        || typeof exitValue !== 'number'
      ) {
        return [];
      }

      return snapshots.flatMap((snapshot) => {
        if (typeof snapshot.currentValueSol !== 'number') {
          return [];
        }

        const followThroughPct = ((exitValue - snapshot.currentValueSol) / exitValue) * 100;
        return [{
          supportive: snapshot.currentValueSol < exitValue * 0.75,
          headroomPct: followThroughPct,
          windowLabel: snapshot.windowLabel,
          observedAt: snapshot.observationAt
        }];
      });
    });
  }

  if (proposal.targetPath === 'lpConfig.stopLossNetPnlPct' && proposedValue < oldValue) {
    return outcomes.flatMap((outcome) => {
      const snapshots = findSnapshotsAfterExit({
        tokenMint: outcome.tokenMint,
        closedAt: outcome.closedAt,
        watchlistSnapshots
      });
      const exitValue = outcome.exitMetrics.lpCurrentValueSol;
      if (
        !outcome.actualExitReason.includes('lp-stop-loss')
        || typeof outcome.lpStopLossNetPnlPctAtEntry !== 'number'
        || outcome.lpStopLossNetPnlPctAtEntry !== oldValue
        || typeof exitValue !== 'number'
      ) {
        return [];
      }

      return snapshots.flatMap((snapshot) => {
        if (typeof snapshot.currentValueSol !== 'number') {
          return [];
        }

        const followThroughPct = ((exitValue - snapshot.currentValueSol) / exitValue) * 100;
        return [{
          supportive: snapshot.currentValueSol < exitValue * 0.75,
          headroomPct: followThroughPct,
          windowLabel: snapshot.windowLabel,
          observedAt: snapshot.observationAt
        }];
      });
    });
  }

  if (proposal.targetPath === 'lpConfig.solDepletionExitBins' && proposedValue > oldValue) {
    return outcomes.flatMap((outcome) => {
      const snapshots = findSnapshotsAfterExit({
        tokenMint: outcome.tokenMint,
        closedAt: outcome.closedAt,
        watchlistSnapshots
      });
      const exitValue = outcome.exitMetrics.lpCurrentValueSol;
      if (
        (!outcome.actualExitReason.includes('sol-depletion')
          && outcome.exitMetrics.lpSolDepletedBins !== oldValue)
        || typeof outcome.solDepletionExitBinsAtEntry !== 'number'
        || outcome.solDepletionExitBinsAtEntry !== oldValue
        || typeof exitValue !== 'number'
      ) {
        return [];
      }

      return snapshots.flatMap((snapshot) => {
        if (typeof snapshot.currentValueSol !== 'number') {
          return [];
        }

        const followThroughPct = ((snapshot.currentValueSol - exitValue) / exitValue) * 100;
        return [{
          supportive: snapshot.currentValueSol > exitValue * 1.2,
          headroomPct: followThroughPct,
          windowLabel: snapshot.windowLabel,
          observedAt: snapshot.observationAt
        }];
      });
    });
  }

  return null;
}

function findSnapshotsAfterExit(input: {
  tokenMint: string;
  closedAt?: string;
  watchlistSnapshots: WatchlistSnapshotRecord[];
}) {
  const closedAtMs = typeof input.closedAt === 'string' ? Date.parse(input.closedAt) : Number.NaN;

  return input.watchlistSnapshots
    .filter((snapshot) => {
      if (snapshot.tokenMint !== input.tokenMint) {
        return false;
      }

      if (!Number.isFinite(closedAtMs)) {
        return true;
      }

      return Date.parse(snapshot.observationAt) >= closedAtMs;
    });
}

function emptyReplay(proposal: ParameterProposalRecord): OutcomeReplayRecord {
  return {
    proposalId: proposal.proposalId,
    targetPath: proposal.targetPath,
    replayableSampleCount: 0,
    supportiveSampleCount: 0,
    supportRate: 0,
    averageHeadroomPct: null,
    windowSummaries: [],
    sliceSummaries: []
  };
}

function buildWindowSummaries(
  replayableOutcomes: Array<{ supportive: boolean; headroomPct: number; windowLabel?: string }>
) {
  const grouped = new Map<string, Array<{ supportive: boolean; headroomPct: number }>>();

  for (const outcome of replayableOutcomes) {
    if (typeof outcome.windowLabel !== 'string' || outcome.windowLabel.length === 0) {
      continue;
    }

    const bucket = grouped.get(outcome.windowLabel) ?? [];
    bucket.push({
      supportive: outcome.supportive,
      headroomPct: outcome.headroomPct
    });
    grouped.set(outcome.windowLabel, bucket);
  }

  return [...grouped.entries()]
    .map(([windowLabel, values]) => {
      const supportiveValues = values.filter((value) => value.supportive);
      const headrooms = supportiveValues.map((value) => roundMetric(value.headroomPct));

      return {
        windowLabel,
        replayableSampleCount: values.length,
        supportiveSampleCount: supportiveValues.length,
        supportRate: values.length > 0 ? roundMetric(supportiveValues.length / values.length) : 0,
        averageHeadroomPct: headrooms.length > 0
          ? roundMetric(headrooms.reduce((sum, value) => sum + value, 0) / headrooms.length)
          : null
      };
    })
    .sort((left, right) => compareWindowLabels(left.windowLabel, right.windowLabel));
}

function buildSliceSummaries(
  replayableOutcomes: Array<{ supportive: boolean; headroomPct: number; observedAt?: string }>
) {
  const observed = replayableOutcomes.filter((outcome) => typeof outcome.observedAt === 'string');
  if (observed.length === 0) {
    return [] as OutcomeReplaySliceSummary[];
  }

  if (observed.length <= 1) {
    return [summarizeSlice('all-observed', observed)];
  }

  const chronologicallySorted = [...observed].sort((left, right) =>
    (left.observedAt ?? '').localeCompare(right.observedAt ?? '')
  );
  const midpoint = Math.floor(chronologicallySorted.length / 2);
  if (midpoint <= 0 || midpoint >= chronologicallySorted.length) {
    return [summarizeSlice('all-observed', chronologicallySorted)];
  }

  return [
    summarizeSlice('earlier-half', chronologicallySorted.slice(0, midpoint)),
    summarizeSlice('later-half', chronologicallySorted.slice(midpoint))
  ];
}

function summarizeSlice(
  sliceLabel: string,
  replayableOutcomes: Array<{ supportive: boolean; headroomPct: number }>
): OutcomeReplaySliceSummary {
  const supportiveOutcomes = replayableOutcomes.filter((outcome) => outcome.supportive);
  const headrooms = supportiveOutcomes.map((outcome) => roundMetric(outcome.headroomPct));

  return {
    sliceLabel,
    replayableSampleCount: replayableOutcomes.length,
    supportiveSampleCount: supportiveOutcomes.length,
    supportRate: replayableOutcomes.length > 0
      ? roundMetric(supportiveOutcomes.length / replayableOutcomes.length)
      : 0,
    averageHeadroomPct: headrooms.length > 0
      ? roundMetric(headrooms.reduce((sum, value) => sum + value, 0) / headrooms.length)
      : null
  };
}

function compareWindowLabels(left: string, right: string) {
  return parseWindowLabelHours(left) - parseWindowLabelHours(right);
}

function parseWindowLabelHours(windowLabel: string) {
  const trimmed = windowLabel.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(m|h|d)$/);
  if (!match) {
    return Number.POSITIVE_INFINITY;
  }

  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value)) {
    return Number.POSITIVE_INFINITY;
  }

  if (unit === 'm') {
    return value / 60;
  }

  if (unit === 'd') {
    return value * 24;
  }

  return value;
}

function roundMetric(value: number) {
  return Math.round(value * 10000) / 10000;
}
