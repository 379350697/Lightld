import {
  ValidationCoverageV2Schema,
  ValidationMetricsV2Schema,
  type ValidationCoverageV2,
  type ValidationMetricsV2
} from './types.ts';
import type {
  EconomicShadowBenchmarkNameV2,
  EconomicShadowPortfolioResultV2
} from './economic-shadow.ts';

export type ValidationCoverageEpisodeV2 = {
  episodeId: string;
  capturedAt: string;
  poolAddress: string;
  deployerAddress?: string | null;
  marketRegime: string;
  netPnlSol?: number;
};

export type BootstrapReturnObservationV2 = {
  episodeId: string;
  blockKey: string;
  afterCostReturn: number;
};

export type BlockBootstrapResultV2 = {
  schemaVersion: 2;
  method: 'cluster_block_bootstrap_v2';
  iterationCount: number;
  blockCount: number;
  observationCount: number;
  observedGeometricReturn: number;
  lower95GeometricReturn: number;
  upper95GeometricReturn: number;
};

export type ValidationMetricObservationV2 = {
  episodeId: string;
  afterCostReturn: number;
  baselineAfterCostReturn?: number;
  marketRegime?: string;
};

export type BuildValidationMetricsV2Input = {
  observations: ValidationMetricObservationV2[];
  oosGeometricReturnLower95: number;
  deflatedSharpePValue: number;
  probabilityOfBacktestOverfitting: number;
  hansenSpaPValue: number;
  bhFdrQValue: number;
  capacityDecayAtDoubleSizePct: number;
  targetSizeExitExecutable: boolean;
  doubleSizeExitExecutable: boolean;
  trimPct?: number;
  ruinEquityFraction?: number;
  regimeDirectionConsistent?: boolean;
};

export function buildValidationMetricObservationsFromEconomicShadowV2(
  portfolio: EconomicShadowPortfolioResultV2,
  baseline: EconomicShadowBenchmarkNameV2 = 'hold_sol'
): ValidationMetricObservationV2[] {
  return portfolio.episodes
    .filter((episode) => episode.status === 'simulated' && episode.pnl !== null)
    .map((episode) => {
      const benchmark = episode.benchmarks.find((entry) => entry.name === baseline);
      return {
        episodeId: episode.episodeId,
        afterCostReturn: episode.pnl!.afterCostReturnPct,
        baselineAfterCostReturn: benchmark?.afterCostReturnPct ?? 0
      };
    });
}

export function buildValidationCoverageV2(
  episodes: ValidationCoverageEpisodeV2[],
  untouchedOosEpisodeIds: Iterable<string> = []
): ValidationCoverageV2 {
  const uniqueEpisodes = uniqueByEpisodeId(episodes);
  const untouchedOos = new Set(untouchedOosEpisodeIds);
  const poolCounts = countBy(uniqueEpisodes, (episode) => episode.poolAddress);
  const deployerCounts = countBy(uniqueEpisodes, (episode) => episode.deployerAddress ?? '');
  const naturalDays = new Set(uniqueEpisodes.map((episode) => episode.capturedAt.slice(0, 10))).size;
  const marketRegimes = new Set(uniqueEpisodes.map((episode) => episode.marketRegime)).size;
  const positiveProfitByPool = new Map<string, number>();

  for (const episode of uniqueEpisodes) {
    const pnl = episode.netPnlSol ?? 0;
    if (pnl > 0) {
      positiveProfitByPool.set(episode.poolAddress, (positiveProfitByPool.get(episode.poolAddress) ?? 0) + pnl);
    }
  }

  return ValidationCoverageV2Schema.parse({
    independentEpisodes: uniqueEpisodes.length,
    naturalDays,
    untouchedOosEpisodes: uniqueEpisodes.filter((episode) => untouchedOos.has(episode.episodeId)).length,
    marketRegimes,
    maxPoolEpisodeContributionPct: maxContributionPct(poolCounts, uniqueEpisodes.length),
    maxPoolProfitContributionPct: maxPositiveProfitContributionPct(positiveProfitByPool),
    maxDeployerEpisodeContributionPct: maxContributionPct(
      new Map([...deployerCounts.entries()].filter(([deployer]) => deployer.length > 0)),
      uniqueEpisodes.length
    )
  });
}

export function blockBootstrapGeometricReturnV2(input: {
  observations: BootstrapReturnObservationV2[];
  iterations?: number;
  seed?: number;
}): BlockBootstrapResultV2 {
  const observations = uniqueByEpisodeId(input.observations);
  const iterations = input.iterations ?? 10_000;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error('bootstrap iterations must be a positive integer.');
  }
  if (observations.length === 0) {
    throw new Error('bootstrap requires at least one independent episode.');
  }

  const blocks = [...groupBy(observations, (observation) => observation.blockKey).values()];
  const random = seededRandom(input.seed ?? 0x5eed_2026);
  const bootstrapped: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampled: BootstrapReturnObservationV2[] = [];
    for (let draw = 0; draw < blocks.length; draw += 1) {
      const index = Math.floor(random() * blocks.length);
      sampled.push(...blocks[index]);
    }
    bootstrapped.push(geometricMeanReturn(sampled.map((entry) => entry.afterCostReturn)));
  }
  bootstrapped.sort((left, right) => left - right);

  return {
    schemaVersion: 2,
    method: 'cluster_block_bootstrap_v2',
    iterationCount: iterations,
    blockCount: blocks.length,
    observationCount: observations.length,
    observedGeometricReturn: geometricMeanReturn(observations.map((entry) => entry.afterCostReturn)),
    lower95GeometricReturn: percentileSorted(bootstrapped, 0.05),
    upper95GeometricReturn: percentileSorted(bootstrapped, 0.95)
  };
}

export function buildValidationMetricsV2(input: BuildValidationMetricsV2Input): ValidationMetricsV2 {
  const observations = uniqueByEpisodeId(input.observations);
  if (observations.length === 0) {
    throw new Error('validation metrics require at least one independent episode.');
  }
  const returns = observations.map((observation) => finiteNumber(observation.afterCostReturn, 'afterCostReturn'));
  const baselineReturns = observations.map((observation) => finiteNumber(
    observation.baselineAfterCostReturn ?? 0,
    'baselineAfterCostReturn'
  ));
  const candidateMaxDrawdownPct = maxDrawdownPct(returns);
  const baselineMaxDrawdownPct = maxDrawdownPct(baselineReturns);

  return ValidationMetricsV2Schema.parse({
    afterCostArithmeticReturn: arithmeticMean(returns),
    afterCostGeometricReturn: geometricMeanReturn(returns),
    medianReturn: median(returns),
    trimmedMeanReturn: trimmedMean(returns, input.trimPct ?? 0.1),
    profitFactor: profitFactor(returns),
    sortinoRatio: sortinoRatio(returns),
    calmarRatio: candidateMaxDrawdownPct > 0 ? geometricMeanReturn(returns) / candidateMaxDrawdownPct : null,
    oosGeometricReturnLower95: finiteNumber(input.oosGeometricReturnLower95, 'oosGeometricReturnLower95'),
    deflatedSharpePValue: finiteNumber(input.deflatedSharpePValue, 'deflatedSharpePValue'),
    probabilityOfBacktestOverfitting: finiteNumber(input.probabilityOfBacktestOverfitting, 'probabilityOfBacktestOverfitting'),
    hansenSpaPValue: finiteNumber(input.hansenSpaPValue, 'hansenSpaPValue'),
    bhFdrQValue: finiteNumber(input.bhFdrQValue, 'bhFdrQValue'),
    candidateExpectedShortfall95: expectedShortfallLoss(returns, 0.95),
    baselineExpectedShortfall95: expectedShortfallLoss(baselineReturns, 0.95),
    candidateExpectedShortfall99: expectedShortfallLoss(returns, 0.99),
    baselineExpectedShortfall99: expectedShortfallLoss(baselineReturns, 0.99),
    candidateMaxDrawdownPct,
    baselineMaxDrawdownPct,
    lossClusteringScore: lossClusteringScore(returns),
    ruinProbability: realizedRuinProbability(returns, input.ruinEquityFraction ?? 0.5),
    capacityDecayAtDoubleSizePct: finiteNumber(input.capacityDecayAtDoubleSizePct, 'capacityDecayAtDoubleSizePct'),
    regimeDirectionConsistent: input.regimeDirectionConsistent ?? inferRegimeDirectionConsistency(observations),
    targetSizeExitExecutable: input.targetSizeExitExecutable,
    doubleSizeExitExecutable: input.doubleSizeExitExecutable
  });
}

export function geometricMeanReturn(returns: number[]) {
  if (returns.length === 0) {
    throw new Error('geometric mean requires at least one return.');
  }
  if (returns.some((value) => !Number.isFinite(value))) {
    throw new Error('returns must be finite.');
  }
  if (returns.some((value) => value <= -1)) {
    return -1;
  }
  const logMean = returns.reduce((total, value) => total + Math.log1p(value), 0) / returns.length;
  return Math.exp(logMean) - 1;
}

function uniqueByEpisodeId<T extends { episodeId: string }>(records: T[]) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const record of records) {
    if (seen.has(record.episodeId)) continue;
    seen.add(record.episodeId);
    result.push(record);
  }
  return result;
}

function countBy<T>(records: T[], key: (record: T) => string) {
  const counts = new Map<string, number>();
  for (const record of records) {
    const value = key(record);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function groupBy<T>(records: T[], key: (record: T) => string) {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const value = key(record);
    groups.set(value, [...(groups.get(value) ?? []), record]);
  }
  return groups;
}

function maxContributionPct(counts: Map<string, number>, denominator: number) {
  if (denominator <= 0 || counts.size === 0) return 0;
  return Math.max(...counts.values()) / denominator * 100;
}

function maxPositiveProfitContributionPct(profitByPool: Map<string, number>) {
  const total = [...profitByPool.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  return Math.max(...profitByPool.values()) / total * 100;
}

function percentileSorted(sorted: number[], percentile: number) {
  if (sorted.length === 0) {
    throw new Error('percentile requires at least one value.');
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(percentile * (sorted.length - 1))));
  return sorted[index];
}

function finiteNumber(value: number, field: string) {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite.`);
  }
  return value;
}

function arithmeticMean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function trimmedMean(values: number[], trimPct: number) {
  if (!Number.isFinite(trimPct) || trimPct < 0 || trimPct >= 0.5) {
    throw new Error('trimPct must be finite and in [0, 0.5).');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const trimCount = Math.floor(sorted.length * trimPct);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  return arithmeticMean(trimmed.length > 0 ? trimmed : sorted);
}

function profitFactor(returns: number[]) {
  const gains = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = returns.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);
  if (losses === 0) return null;
  return gains / losses;
}

function sortinoRatio(returns: number[]) {
  const downside = returns.map((value) => Math.min(0, value));
  const downsideDeviation = Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / returns.length);
  if (downsideDeviation === 0) return null;
  return arithmeticMean(returns) / downsideDeviation;
}

function expectedShortfallLoss(returns: number[], confidence: 0.95 | 0.99) {
  const sorted = [...returns].sort((left, right) => left - right);
  const tailCount = Math.max(1, Math.ceil((1 - confidence) * sorted.length));
  const tailMean = arithmeticMean(sorted.slice(0, tailCount));
  return Math.max(0, -tailMean);
}

function maxDrawdownPct(returns: number[]) {
  let equity = 1;
  let highWater = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity = Math.max(0, equity * (1 + value));
    highWater = Math.max(highWater, equity);
    maxDrawdown = Math.max(maxDrawdown, highWater === 0 ? 0 : (highWater - equity) / highWater);
  }
  return maxDrawdown;
}

function lossClusteringScore(returns: number[]) {
  let currentRun = 0;
  let longestRun = 0;
  for (const value of returns) {
    if (value < 0) {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  return longestRun / returns.length;
}

function realizedRuinProbability(returns: number[], ruinEquityFraction: number) {
  if (!Number.isFinite(ruinEquityFraction) || ruinEquityFraction <= 0 || ruinEquityFraction >= 1) {
    throw new Error('ruinEquityFraction must be finite and in (0, 1).');
  }
  let equity = 1;
  for (const value of returns) {
    equity = Math.max(0, equity * (1 + value));
    if (equity <= ruinEquityFraction) return 1;
  }
  return 0;
}

function inferRegimeDirectionConsistency(observations: ValidationMetricObservationV2[]) {
  const regimeGroups = groupBy(
    observations.filter((observation) => typeof observation.marketRegime === 'string' && observation.marketRegime.length > 0),
    (observation) => observation.marketRegime as string
  );
  if (regimeGroups.size === 0) return true;
  return [...regimeGroups.values()].every((group) => (
    arithmeticMean(group.map((observation) => observation.afterCostReturn)) > 0
  ));
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
