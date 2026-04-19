import type { ParameterProposalRecord, PoolDecisionSampleRecord } from './types.ts';

const REPLAYABLE_PATHS: Record<string, { blockedReason: string; field: keyof PoolDecisionSampleRecord['candidateFeatures'] }> = {
  'filters.minLiquidityUsd': { blockedReason: 'min-liquidity', field: 'liquidityUsd' },
  'lpConfig.minBinStep': { blockedReason: 'min-bin-step', field: 'binStep' },
  'lpConfig.minVolume24hUsd': { blockedReason: 'min-volume-24h', field: 'volume24h' },
  'lpConfig.minFeeTvlRatio24h': { blockedReason: 'min-fee-tvl-ratio-24h', field: 'feeTvlRatio24h' }
};

export type CounterfactualReplayWindowSummary = {
  windowLabel: string;
  sampleCount: number;
  outperformCount: number;
  outperformRate: number;
  averageRelativeToSelectedBaselineSol: number;
};

export type CounterfactualReplaySliceSummary = {
  sliceLabel: string;
  sampleCount: number;
  outperformCount: number;
  outperformRate: number;
  averageRelativeToSelectedBaselineSol: number;
};

export type CounterfactualReplayRecord = {
  proposalId: string;
  targetPath: string;
  admittedSampleCount: number;
  positiveRelativeSamples: number;
  averageRelativeToSelectedBaselineSol: number | null;
  windowSummaries: CounterfactualReplayWindowSummary[];
  sliceSummaries: CounterfactualReplaySliceSummary[];
};

export function replayParameterProposals(input: {
  proposals: ParameterProposalRecord[];
  samples: PoolDecisionSampleRecord[];
}): CounterfactualReplayRecord[] {
  return input.proposals.map((proposal) => {
    const config = REPLAYABLE_PATHS[proposal.targetPath];
    if (!config || typeof proposal.oldValue !== 'number' || typeof proposal.proposedValue !== 'number') {
      return emptyReplay(proposal);
    }
    const oldValue = proposal.oldValue;
    const proposedValue = proposal.proposedValue;

    const admittedSamples = input.samples.filter((sample) => {
      if (sample.decision.selected || sample.decision.blockedReason !== config.blockedReason) {
        return false;
      }

      const featureValue = sample.candidateFeatures[config.field];
      if (typeof featureValue !== 'number') {
        return false;
      }

      if (proposedValue < oldValue) {
        return featureValue >= proposedValue && featureValue < oldValue;
      }

      return false;
    });

    if (admittedSamples.length === 0) {
      return emptyReplay(proposal);
    }

    const relativeValues = admittedSamples
      .map((sample) => sample.counterfactual.relativeToSelectedBaselineSol)
      .filter((value): value is number => typeof value === 'number');

    return {
      proposalId: proposal.proposalId,
      targetPath: proposal.targetPath,
      admittedSampleCount: admittedSamples.length,
      positiveRelativeSamples: relativeValues.filter((value) => value > 0).length,
      averageRelativeToSelectedBaselineSol: relativeValues.length > 0
        ? roundMetric(relativeValues.reduce((sum, value) => sum + value, 0) / relativeValues.length)
        : null,
      windowSummaries: buildWindowSummaries(admittedSamples),
      sliceSummaries: buildSliceSummaries(admittedSamples)
    };
  });
}

function emptyReplay(proposal: ParameterProposalRecord): CounterfactualReplayRecord {
  return {
    proposalId: proposal.proposalId,
    targetPath: proposal.targetPath,
    admittedSampleCount: 0,
    positiveRelativeSamples: 0,
    averageRelativeToSelectedBaselineSol: null,
    windowSummaries: [],
    sliceSummaries: []
  };
}

function buildWindowSummaries(samples: PoolDecisionSampleRecord[]): CounterfactualReplayWindowSummary[] {
  const grouped = new Map<string, number[]>();

  for (const sample of samples) {
    for (const [windowLabel, value] of Object.entries(sample.counterfactual.relativeToSelectedBaselineByWindowLabel)) {
      if (typeof value !== 'number') {
        continue;
      }

      const bucket = grouped.get(windowLabel) ?? [];
      bucket.push(value);
      grouped.set(windowLabel, bucket);
    }
  }

  return [...grouped.entries()]
    .map(([windowLabel, values]) => {
      const outperformCount = values.filter((value) => value > 0).length;
      return {
        windowLabel,
        sampleCount: values.length,
        outperformCount,
        outperformRate: roundMetric(outperformCount / Math.max(1, values.length)),
        averageRelativeToSelectedBaselineSol: roundMetric(
          values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
        )
      } satisfies CounterfactualReplayWindowSummary;
    })
    .sort((left, right) => parseWindowLabelHours(left.windowLabel) - parseWindowLabelHours(right.windowLabel));
}

function buildSliceSummaries(samples: PoolDecisionSampleRecord[]): CounterfactualReplaySliceSummary[] {
  if (samples.length <= 1) {
    return [summarizeSlice('all-observed', samples)];
  }

  const chronologicallySorted = [...samples].sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt)
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

function summarizeSlice(sliceLabel: string, samples: PoolDecisionSampleRecord[]): CounterfactualReplaySliceSummary {
  const values = samples
    .map((sample) => sample.counterfactual.relativeToSelectedBaselineSol)
    .filter((value): value is number => typeof value === 'number');
  const outperformCount = values.filter((value) => value > 0).length;

  return {
    sliceLabel,
    sampleCount: samples.length,
    outperformCount,
    outperformRate: roundMetric(outperformCount / Math.max(1, samples.length)),
    averageRelativeToSelectedBaselineSol: roundMetric(
      values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
    )
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

function roundMetric(value: number) {
  return Math.round(value * 10000) / 10000;
}
