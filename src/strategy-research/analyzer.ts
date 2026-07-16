import { createHash } from 'node:crypto';

import type { StrategyConfig } from '../config/schema.ts';
import { pairedBlockBootstrap, summarizePnl } from './statistics.ts';
import { applyStrategyPatch } from './spec.ts';
import { StrategyResearchStore } from './store.ts';
import {
  RESEARCH_HORIZON_TOLERANCE_MINUTES,
  RESEARCH_REVIEW_FLOORS,
  type ResearchEpisode,
  type ResearchMark,
  type StrategyResearchReportStatus,
  type StrategyResearchSpec
} from './types.ts';

type EconomicRow = {
  snapshotId: string;
  variantId: string;
  observedAt: string;
  pnlSol: number;
  capacityPass: boolean;
  regime: string;
  exitHorizonMinutes: number;
  costBreakdown: {
    routeAndPriceSol: number;
    estimatedFeeSol: number;
    impermanentLossSol: number;
    adverseSelectionSol: number;
    capitalChargeSol: number;
    chainCostSol: number;
  };
};

export function analyzeStrategyResearch(store: StrategyResearchStore, spec: StrategyResearchSpec) {
  const episodes = store.listEpisodes(spec.experimentId).filter((episode) => episode.selected);
  const marks = store.listMarks(spec.experimentId);
  const marksByEpisode = new Map<string, ResearchMark[]>();
  for (const mark of marks) {
    const episode = episodes.find((candidate) => candidate.episodeId === mark.episodeId);
    if (!episode || !isOnTimeMark(episode, mark)) continue;
    const current = marksByEpisode.get(mark.episodeId) ?? [];
    current.push(mark);
    marksByEpisode.set(mark.episodeId, current);
  }
  if (!spec.baseConfig) throw new Error('Strategy research experiment is missing its locked baseline config');
  const configByVariant = new Map<string, StrategyConfig>([
    ['baseline', spec.baseConfig],
    ...spec.variants.map((variant) => [variant.variantId, applyStrategyPatch(spec.baseConfig!, variant.parameterPatch)] as const)
  ]);
  const rows = episodes.flatMap((episode) => {
    const config = configByVariant.get(episode.variantId);
    const economic = config ? economicRow(episode, marksByEpisode.get(episode.episodeId) ?? [], config) : null;
    return economic ? [economic] : [];
  });
  const variants = ['baseline', ...spec.variants.map((variant) => variant.variantId)];
  const summaries = variants.map((variantId) => {
    const variantRows = rows.filter((row) => row.variantId === variantId);
    return {
      variantId,
      ...summarizePnl(variantRows.map((row) => row.pnlSol)),
      capacityPassRate: variantRows.length ? variantRows.filter((row) => row.capacityPass).length / variantRows.length : 0,
      averageExitHorizonMinutes: variantRows.length
        ? variantRows.reduce((sum, row) => sum + row.exitHorizonMinutes, 0) / variantRows.length
        : 0,
      averageCosts: averageCosts(variantRows),
      regimes: Object.fromEntries([...new Set(variantRows.map((row) => row.regime))].map((regime) => [
        regime,
        summarizePnl(variantRows.filter((row) => row.regime === regime).map((row) => row.pnlSol))
      ]))
    };
  });
  const baselineBySnapshot = new Map(rows.filter((row) => row.variantId === 'baseline').map((row) => [row.snapshotId, row]));
  const comparisons = spec.variants.map((variant) => {
    const pairs = rows
      .filter((row) => row.variantId === variant.variantId && baselineBySnapshot.has(row.snapshotId))
      .map((row) => ({ row, difference: row.pnlSol - baselineBySnapshot.get(row.snapshotId)!.pnlSol }))
      .sort((left, right) => Date.parse(left.row.observedAt) - Date.parse(right.row.observedAt));
    const split = splitWithEmbargo(pairs, 24 * 60 * 60_000);
    return {
      variantId: variant.variantId,
      pairCount: pairs.length,
      bootstrap: pairedBlockBootstrap(pairs.map((pair) => pair.difference)),
      train: summarizePnl(split.train.map((pair) => pair.difference)),
      validation: summarizePnl(split.validation.map((pair) => pair.difference)),
      oos: summarizePnl(split.oos.map((pair) => pair.difference)),
      capacityPassRate: pairs.length ? pairs.filter((pair) => pair.row.capacityPass).length / pairs.length : 0
    };
  });
  const selectedEpisodes = episodes.length;
  const expectedMarks = selectedEpisodes * 4;
  const availableMarks = marks.filter((mark) => {
    const episode = episodes.find((item) => item.episodeId === mark.episodeId);
    return Boolean(episode) && isOnTimeMark(episode!, mark) && mark.status !== 'unavailable' && mark.status !== 'missed';
  }).length;
  const markCoverage = expectedMarks ? availableMarks / expectedMarks : 0;
  const observedUtcDays = new Set(episodes.map((episode) => episode.observedAt.slice(0, 10))).size;
  const utcDays = countCompleteUtcDays(store.snapshotTimes(spec.experimentId));
  const thresholds = {
    minimumEpisodes: Math.max(spec.thresholds.minimumEpisodes, RESEARCH_REVIEW_FLOORS.minimumEpisodes),
    minimumUtcDays: Math.max(spec.thresholds.minimumUtcDays, RESEARCH_REVIEW_FLOORS.minimumUtcDays),
    minimumOosEpisodes: Math.max(spec.thresholds.minimumOosEpisodes, RESEARCH_REVIEW_FLOORS.minimumOosEpisodes),
    minimumMarkCoverage: Math.max(spec.thresholds.minimumMarkCoverage, RESEARCH_REVIEW_FLOORS.minimumMarkCoverage)
  };
  const sufficientlySampled = comparisons.filter((comparison) =>
    comparison.pairCount >= thresholds.minimumEpisodes
    && comparison.oos.count >= thresholds.minimumOosEpisodes
  );
  const blockingReasons: string[] = [];
  if (!comparisons.some((comparison) => comparison.pairCount >= thresholds.minimumEpisodes)) {
    blockingReasons.push('minimum_episodes_not_met');
  }
  if (utcDays < thresholds.minimumUtcDays) blockingReasons.push('minimum_utc_days_not_met');
  if (!comparisons.some((comparison) => comparison.oos.count >= thresholds.minimumOosEpisodes)) {
    blockingReasons.push('minimum_oos_episodes_not_met');
  }
  if (blockingReasons.length === 0 && sufficientlySampled.length === 0) {
    blockingReasons.push('minimum_paired_oos_sample_not_met');
  }
  if (markCoverage < thresholds.minimumMarkCoverage) blockingReasons.push('mark_coverage_not_met');
  const reviewCandidates = sufficientlySampled
    .filter((comparison) =>
      comparison.oos.meanPnlSol > 0
      && comparison.bootstrap.lower95 > 0
      && comparison.capacityPassRate >= thresholds.minimumMarkCoverage
    )
    .sort((left, right) => right.oos.meanPnlSol - left.oos.meanPnlSol);
  let status: StrategyResearchReportStatus = 'insufficient';
  if (blockingReasons.length === 0) {
    status = reviewCandidates.length > 0 ? 'review' : 'reject';
  }
  const chosenVariant = status === 'review' ? reviewCandidates[0]?.variantId ?? null : null;
  const patchDraft = chosenVariant
    ? spec.variants.find((variant) => variant.variantId === chosenVariant)?.parameterPatch ?? null
    : null;
  const paperRows = store.paperOutcomes(spec.experimentId);
  const boundPaperRows = paperRows.filter((row) => row.selectionId !== null);
  const createdAt = new Date().toISOString();
  const reportId = `research-report-${createHash('sha256').update(JSON.stringify({ experimentId: spec.experimentId, createdAt, comparisons })).digest('hex').slice(0, 24)}`;
  const report = {
    reportId,
    experimentId: spec.experimentId,
    strategyId: spec.strategyId,
    createdAt,
    status,
    blockingReasons,
    sample: {
      selectedEpisodes,
      utcDays,
      observedUtcDays,
      markCoverage,
      paperOutcomeCount: paperRows.length,
      boundPaperOutcomeCount: boundPaperRows.length
    },
    variants: summaries,
    comparisons,
    paperRealized: summarizePnl(boundPaperRows.map((row) => row.pnlSol)),
    unboundPaperRealized: summarizePnl(paperRows.filter((row) => row.selectionId === null).map((row) => row.pnlSol)),
    chosenVariant,
    patchDraft,
    note: 'review means manual strategy consideration only; configuration is never changed automatically'
  };
  store.saveReport(report);
  return report;
}

export function renderResearchMarkdown(report: ReturnType<typeof analyzeStrategyResearch>) {
  const lines = [
    `# Strategy research: ${report.experimentId}`,
    '',
    `- Status: **${report.status}**`,
    `- Strategy: ${report.strategyId}`,
    `- Selected episodes: ${report.sample.selectedEpisodes}`,
    `- UTC days: ${report.sample.utcDays}`,
    `- Observed UTC dates: ${report.sample.observedUtcDays}`,
    `- Mark coverage: ${(report.sample.markCoverage * 100).toFixed(1)}%`,
    `- Paper realized outcomes: ${report.sample.paperOutcomeCount}`,
    `- Bound paper outcomes: ${report.sample.boundPaperOutcomeCount}`,
    ''
  ];
  if (report.blockingReasons.length) lines.push(`Blocking: ${report.blockingReasons.join(', ')}`, '');
  for (const comparison of report.comparisons) {
    lines.push(
      `## ${comparison.variantId} vs baseline`,
      '',
      `- Pairs: ${comparison.pairCount}`,
      `- OOS mean difference: ${comparison.oos.meanPnlSol.toFixed(9)} SOL`,
      `- Bootstrap 95% CI: [${comparison.bootstrap.lower95.toFixed(9)}, ${comparison.bootstrap.upper95.toFixed(9)}] SOL`,
      `- OOS win rate: ${(comparison.oos.winRate * 100).toFixed(1)}%`,
      `- OOS p05 loss: ${comparison.oos.p05PnlSol.toFixed(9)} SOL`,
      `- OOS max drawdown: ${comparison.oos.maxDrawdownSol.toFixed(9)} SOL`,
      `- Target/2x capacity pass: ${(comparison.capacityPassRate * 100).toFixed(1)}%`,
      ''
    );
  }
  if (report.patchDraft) lines.push('## Manual patch draft', '', '```json', JSON.stringify(report.patchDraft, null, 2), '```', '');
  lines.push('This report never applies strategy configuration automatically.', '');
  return lines.join('\n');
}

function economicRow(episode: ResearchEpisode, marks: ResearchMark[], config: StrategyConfig): EconomicRow | null {
  if (episode.entryStatus === 'no_route' || episode.entryStatus === 'dead_pool' || episode.entryStatus === 'rug') {
    return noEntryEconomicRow(episode);
  }
  const ordered = [...marks].sort((left, right) => left.horizonMinutes - right.horizonMinutes);
  const failure = ordered.find((mark) => mark.status === 'dead_pool' || mark.status === 'rug')
    ?? ordered.find((mark) => mark.horizonMinutes === 1440 && mark.status === 'no_route');
  if (failure) {
    return failedEconomicRow(episode, failure.horizonMinutes);
  }
  const usable = ordered.filter((mark) => mark.status === 'ok' && mark.targetRecoverySol !== null && mark.doubleRecoverySol !== null);
  if (!usable.some((mark) => mark.horizonMinutes === 1440)) return null;
  const evaluated = usable.map((mark) => economicAtMark(episode, mark, config));
  const takeProfitPct = config.lpConfig?.takeProfitNetPnlPct ?? config.riskThresholds.takeProfitPct;
  const stopLossPct = config.lpConfig?.stopLossNetPnlPct ?? config.riskThresholds.stopLossPct;
  const maxImpermanentLossPct = config.lpConfig?.maxImpermanentLossPct;
  const chosen = evaluated.find((row) =>
    (takeProfitPct !== undefined && row.pnlSol / episode.positionSol * 100 >= takeProfitPct)
    || (stopLossPct !== undefined && row.pnlSol / episode.positionSol * 100 <= -stopLossPct)
    || (maxImpermanentLossPct !== undefined
      && row.costBreakdown.impermanentLossSol / episode.positionSol * 100 >= maxImpermanentLossPct)
  ) ?? evaluated.find((row) => row.exitHorizonMinutes === 1440);
  return chosen ?? null;
}

function noEntryEconomicRow(episode: ResearchEpisode): EconomicRow {
  return {
    snapshotId: episode.snapshotId,
    variantId: episode.variantId,
    observedAt: episode.observedAt,
    pnlSol: 0,
    capacityPass: false,
    regime: regime(episode),
    exitHorizonMinutes: 0,
    costBreakdown: {
      routeAndPriceSol: 0,
      estimatedFeeSol: 0,
      impermanentLossSol: 0,
      adverseSelectionSol: 0,
      capitalChargeSol: 0,
      chainCostSol: 0
    }
  };
}

function failedEconomicRow(episode: ResearchEpisode, exitHorizonMinutes: number): EconomicRow {
  return {
    snapshotId: episode.snapshotId,
    variantId: episode.variantId,
    observedAt: episode.observedAt,
    pnlSol: -episode.positionSol,
    capacityPass: false,
    regime: regime(episode),
    exitHorizonMinutes,
    costBreakdown: {
      routeAndPriceSol: -episode.positionSol,
      estimatedFeeSol: 0,
      impermanentLossSol: 0,
      adverseSelectionSol: 0,
      capitalChargeSol: 0,
      chainCostSol: 0
    }
  };
}

function averageCosts(rows: EconomicRow[]) {
  const keys = [
    'routeAndPriceSol',
    'estimatedFeeSol',
    'impermanentLossSol',
    'adverseSelectionSol',
    'capitalChargeSol',
    'chainCostSol'
  ] as const;
  return Object.fromEntries(keys.map((key) => [
    key,
    rows.length ? rows.reduce((sum, row) => sum + row.costBreakdown[key], 0) / rows.length : 0
  ]));
}

function economicAtMark(episode: ResearchEpisode, mark: ResearchMark, config: StrategyConfig): EconomicRow {
  const targetRecoverySol = mark.targetRecoverySol!;
  const doubleRecoverySol = mark.doubleRecoverySol!;
  const feeRatioRaw = Number(episode.features.feeTvlRatio24h ?? 0);
  const feeRatio = feeRatioRaw > 1 ? feeRatioRaw / 100 : feeRatioRaw;
  const estimatedFeeSol = Number.isFinite(feeRatio) && feeRatio > 0
    ? episode.positionSol * feeRatio * mark.horizonMinutes / 1440
    : 0;
  // A DLMM position cannot be valued with the constant-product IL formula. Until an
  // actual paper position valuation is available, use the configured conservative
  // range-loss allowance and label the report as modeled rather than observed PnL.
  const impermanentLossSol = episode.positionSol
    * (config.entryEdge?.defaultImpermanentLossBps ?? 25) / 10_000
    * mark.horizonMinutes / 1440;
  const adverseSelectionSol = episode.positionSol * (config.entryEdge?.defaultAdverseSelectionBps ?? 25) / 10_000;
  const capitalChargeSol = episode.positionSol * (config.entryEdge?.defaultCapitalChargeBps ?? 5) / 10_000;
  const chainCostSol = config.entryEdge?.defaultChainCostSol ?? 0.000005;
  const pnlSol = targetRecoverySol + estimatedFeeSol - episode.positionSol
    - impermanentLossSol - adverseSelectionSol - capitalChargeSol - chainCostSol;
  const targetRate = targetRecoverySol / episode.positionSol;
  const doubleRate = doubleRecoverySol / (episode.positionSol * 2);
  const impactWithinLimit = (mark.targetImpactBps ?? Number.POSITIVE_INFINITY) <= config.solRouteLimits.maxImpactBps
    && (mark.doubleImpactBps ?? Number.POSITIVE_INFINITY) <= config.solRouteLimits.maxImpactBps;
  return {
    snapshotId: episode.snapshotId,
    variantId: episode.variantId,
    observedAt: episode.observedAt,
    pnlSol,
    capacityPass: targetRate > 0 && doubleRate >= targetRate * 0.9 && impactWithinLimit,
    regime: regime(episode),
    exitHorizonMinutes: mark.horizonMinutes,
    costBreakdown: {
      routeAndPriceSol: targetRecoverySol - episode.positionSol,
      estimatedFeeSol,
      impermanentLossSol,
      adverseSelectionSol,
      capitalChargeSol,
      chainCostSol
    }
  };
}

function regime(episode: ResearchEpisode) {
  const feeYield = Number(episode.features.feeTvlRatio24h ?? 0);
  const liquidity = Number(episode.features.liquidityUsd ?? 0);
  if (feeYield >= 0.1) return 'high-fee-yield';
  if (liquidity >= 100_000) return 'deep-liquidity';
  return 'normal';
}

function splitWithEmbargo<T extends { row: { observedAt: string } }>(rows: T[], embargoMs: number) {
  const trainEnd = Math.floor(rows.length * 0.6);
  const validationEnd = Math.floor(rows.length * 0.8);
  const train = rows.slice(0, trainEnd);
  const validationBoundary = train.length ? Date.parse(train[train.length - 1]!.row.observedAt) + embargoMs : Number.NEGATIVE_INFINITY;
  const validationRaw = rows.slice(trainEnd, validationEnd).filter((item) => Date.parse(item.row.observedAt) >= validationBoundary);
  const oosBoundary = validationRaw.length ? Date.parse(validationRaw[validationRaw.length - 1]!.row.observedAt) + embargoMs : validationBoundary;
  const oos = rows.slice(validationEnd).filter((item) => Date.parse(item.row.observedAt) >= oosBoundary);
  return { train, validation: validationRaw, oos };
}

function isOnTimeMark(episode: ResearchEpisode, mark: ResearchMark) {
  const elapsedMinutes = (Date.parse(mark.observedAt) - Date.parse(episode.observedAt)) / 60_000;
  const tolerance = RESEARCH_HORIZON_TOLERANCE_MINUTES[mark.horizonMinutes];
  return Number.isFinite(elapsedMinutes)
    && elapsedMinutes >= mark.horizonMinutes
    && elapsedMinutes <= mark.horizonMinutes + tolerance;
}

function countCompleteUtcDays(snapshotTimes: string[]) {
  const bucketsByDay = new Map<string, Set<number>>();
  for (const value of snapshotTimes) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) continue;
    const date = new Date(timestamp);
    const day = date.toISOString().slice(0, 10);
    const bucket = date.getUTCHours() * 4 + Math.floor(date.getUTCMinutes() / 15);
    const buckets = bucketsByDay.get(day) ?? new Set<number>();
    buckets.add(bucket);
    bucketsByDay.set(day, buckets);
  }
  return [...bucketsByDay.values()].filter((buckets) =>
    buckets.size >= 86 && buckets.has(0) && buckets.has(95)
  ).length;
}
