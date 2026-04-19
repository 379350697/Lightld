import type { AnalysisNoActionReason, PoolDecisionSampleRecord } from './types.ts';

const COUNTERFACTUAL_PATHS: Record<string, string> = {
  'min-liquidity': 'filters.minLiquidityUsd',
  'min-bin-step': 'lpConfig.minBinStep',
  'min-volume-24h': 'lpConfig.minVolume24hUsd',
  'min-fee-tvl-ratio-24h': 'lpConfig.minFeeTvlRatio24h'
};

export type CounterfactualPathSummary = {
  targetPath: string;
  blockedReason: string;
  sampleCount: number;
  outperformCount: number;
  outperformRate: number;
  averageRelativeToSelectedBaselineSol: number;
  averageBestWindowValueSol: number | null;
  sliceSummaries: CounterfactualSliceSummary[];
};

export type CounterfactualSliceSummary = {
  sliceLabel: string;
  sampleCount: number;
  outperformCount: number;
  outperformRate: number;
  averageRelativeToSelectedBaselineSol: number;
};

export type CounterfactualAnalysisSummary = {
  totalSamples: number;
  eligibleCounterfactualSamples: number;
  positiveRelativeSamples: number;
};

export type CounterfactualAnalysisResult = {
  summary: CounterfactualAnalysisSummary;
  pathSummaries: CounterfactualPathSummary[];
  noActionReasons: AnalysisNoActionReason[];
};

export function analyzeCounterfactualSamples(input: {
  samples: PoolDecisionSampleRecord[];
  minimumSampleSize?: number;
}): CounterfactualAnalysisResult {
  const minimumSampleSize = input.minimumSampleSize ?? 5;
  const eligibleSamples = input.samples.filter((sample) =>
    !sample.decision.selected
    && sample.decision.blockedReason.length > 0
    && typeof sample.counterfactual.relativeToSelectedBaselineSol === 'number'
  );
  const noActionReasons = new Set<AnalysisNoActionReason>();

  if (eligibleSamples.length < minimumSampleSize) {
    noActionReasons.add('insufficient_sample_size');
  }

  if (eligibleSamples.length === 0) {
    noActionReasons.add('data_coverage_gaps');
  }

  const grouped = new Map<string, PoolDecisionSampleRecord[]>();
  for (const sample of eligibleSamples) {
    const targetPath = COUNTERFACTUAL_PATHS[sample.decision.blockedReason];
    if (!targetPath) {
      continue;
    }

    const key = `${sample.decision.blockedReason}::${targetPath}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(sample);
    grouped.set(key, bucket);
  }

  const pathSummaries = [...grouped.entries()]
    .map(([key, samples]) => {
      const [blockedReason, targetPath] = key.split('::');
      const outperformCount = samples.filter((sample) => sample.counterfactual.outperformedSelectedBaseline).length;
      const averageRelativeToSelectedBaselineSol = roundMetric(
        samples.reduce(
          (sum, sample) => sum + (sample.counterfactual.relativeToSelectedBaselineSol ?? 0),
          0
        ) / samples.length
      );
      const bestWindowValues = samples
        .map((sample) => sample.futurePath.bestWindowValueSol)
        .filter((value): value is number => typeof value === 'number');

      return {
        targetPath,
        blockedReason,
        sampleCount: samples.length,
        outperformCount,
        outperformRate: roundMetric(outperformCount / samples.length),
        averageRelativeToSelectedBaselineSol,
        averageBestWindowValueSol: bestWindowValues.length > 0
          ? roundMetric(bestWindowValues.reduce((sum, value) => sum + value, 0) / bestWindowValues.length)
          : null,
        sliceSummaries: buildSliceSummaries(samples)
      } satisfies CounterfactualPathSummary;
    })
    .sort((left, right) => right.averageRelativeToSelectedBaselineSol - left.averageRelativeToSelectedBaselineSol);

  return {
    summary: {
      totalSamples: input.samples.length,
      eligibleCounterfactualSamples: eligibleSamples.length,
      positiveRelativeSamples: eligibleSamples.filter((sample) =>
        (sample.counterfactual.relativeToSelectedBaselineSol ?? 0) > 0
      ).length
    },
    pathSummaries,
    noActionReasons: [...noActionReasons]
  };
}

function roundMetric(value: number) {
  return Math.round(value * 10000) / 10000;
}

function buildSliceSummaries(samples: PoolDecisionSampleRecord[]): CounterfactualSliceSummary[] {
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

function summarizeSlice(sliceLabel: string, samples: PoolDecisionSampleRecord[]): CounterfactualSliceSummary {
  const outperformCount = samples.filter((sample) => sample.counterfactual.outperformedSelectedBaseline).length;
  const averageRelativeToSelectedBaselineSol = roundMetric(
    samples.reduce(
      (sum, sample) => sum + (sample.counterfactual.relativeToSelectedBaselineSol ?? 0),
      0
    ) / Math.max(1, samples.length)
  );

  return {
    sliceLabel,
    sampleCount: samples.length,
    outperformCount,
    outperformRate: roundMetric(outperformCount / Math.max(1, samples.length)),
    averageRelativeToSelectedBaselineSol
  };
}
