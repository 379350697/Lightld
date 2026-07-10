import { createHash } from 'node:crypto';

import { stableStringify } from '../shared/canonical-json.ts';
import type {
  CapacityPointV2,
  ExecutableMarkV2,
  OpportunityEpisodeV2,
  ResearchHorizonV2
} from './types.ts';

export type EconomicShadowEvidenceTypeV2 = 'simulated_quote' | 'simulated_transaction';

export type EconomicShadowBenchmarkNameV2 =
  | 'no_trade'
  | 'hold_sol'
  | 'direct_token'
  | 'wide_range_lp'
  | 'current_strategy'
  | 'candidate_strategy';

export type EconomicShadowSkipReasonV2 =
  | 'not_selected'
  | 'position_size_exceeds_limit'
  | 'insufficient_available_sol'
  | 'max_active_positions_reached'
  | 'daily_new_risk_limit_reached'
  | 'missing_terminal_mark'
  | 'missed_terminal_mark';

export type EconomicShadowEpisodeInputV2 = {
  episode: OpportunityEpisodeV2;
  marks: ExecutableMarkV2[];
  positionSizeSol: number;
  feeAccrualSol?: number;
  inventoryConversionSol?: number;
  impermanentLossSol?: number;
  residualLiquidationImpactSol?: number;
  baseFeeLamports?: number;
  priorityFeeLamports?: number;
  jitoTipLamports?: number;
  rentLamports?: number;
  failedTransactionProbability?: number;
  failedTransactionCostSol?: number;
  landingLatencyMs?: number;
  timeInRangePct?: number;
  benchmarkValuesSol?: Partial<Record<Exclude<EconomicShadowBenchmarkNameV2, 'no_trade' | 'hold_sol'>, number>>;
};

export type EconomicShadowAccountConfigV2 = {
  startingSol: number;
  solReserve?: number;
  maxActivePositions: number;
  maxDailyNewRiskSol: number;
  maxPositionSol: number;
  terminalHorizon?: ResearchHorizonV2;
};

export type EconomicShadowPnlBreakdownV2 = {
  principalChangeSol: number;
  feeIncomeSol: number;
  inventoryConversionSol: number;
  impermanentLossSol: number;
  roundTripCostSol: number;
  baseFeeSol: number;
  priorityFeeSol: number;
  jitoTipSol: number;
  rentSol: number;
  failedTransactionExpectedCostSol: number;
  residualLiquidationImpactSol: number;
  grossPnlSol: number;
  netPnlSol: number;
  afterCostReturnPct: number;
  feeImpermanentLossRatio: number | null;
};

export type EconomicShadowBenchmarkV2 = {
  name: EconomicShadowBenchmarkNameV2;
  terminalValueSol: number;
  netPnlSol: number;
  afterCostReturnPct: number;
};

export type EconomicShadowEpisodeResultV2 = {
  schemaVersion: 2;
  simulationId: string;
  mode: 'economic-shadow';
  episodeId: string;
  strategyId: OpportunityEpisodeV2['strategyId'];
  tokenMint: string;
  poolAddress: string;
  selected: boolean;
  status: 'simulated' | 'skipped';
  skipReason?: EconomicShadowSkipReasonV2;
  evidenceType: EconomicShadowEvidenceTypeV2;
  fillEvidenceType: EconomicShadowEvidenceTypeV2;
  terminalHorizon: ResearchHorizonV2;
  terminalMarkId: string | null;
  terminalMarkStatus: ExecutableMarkV2['markStatus'] | null;
  terminalRouteStatus: ExecutableMarkV2['routeStatus'] | null;
  positionSizeSol: number;
  exitValueSol: number | null;
  quoteAgeMs: number | null;
  landingLatencyMs: number | null;
  noRouteProbability: number;
  timeInRangePct: number | null;
  mfeSol: number | null;
  maeSol: number | null;
  capacityCurve: CapacityPointV2[];
  pnl: EconomicShadowPnlBreakdownV2 | null;
  benchmarks: EconomicShadowBenchmarkV2[];
};

export type EconomicShadowPortfolioResultV2 = {
  schemaVersion: 2;
  mode: 'economic-shadow';
  generatedAt: string;
  startingSol: number;
  endingEquitySol: number;
  totalNetPnlSol: number;
  simulatedEpisodeCount: number;
  skippedEpisodeCount: number;
  maxActivePositionsObserved: number;
  dailyNewRiskSol: Record<string, number>;
  noRouteProbability: number;
  episodes: EconomicShadowEpisodeResultV2[];
};

type ActiveShadowPosition = {
  closeAtMs: number;
  reservedSol: number;
  netPnlSol: number;
};

const LAMPORTS_PER_SOL = 1_000_000_000;

export function simulateEconomicShadowPortfolioV2(input: {
  episodes: EconomicShadowEpisodeInputV2[];
  account: EconomicShadowAccountConfigV2;
  generatedAt?: string;
}): EconomicShadowPortfolioResultV2 {
  const account = normalizeAccount(input.account);
  const terminalHorizon = account.terminalHorizon ?? '24h';
  const ordered = [...input.episodes].sort((left, right) => (
    Date.parse(left.episode.capturedAt) - Date.parse(right.episode.capturedAt)
  ));

  let realizedEquitySol = account.startingSol;
  const reserveSol = account.solReserve ?? 0;
  const active: ActiveShadowPosition[] = [];
  const dailyNewRiskSol: Record<string, number> = {};
  const results: EconomicShadowEpisodeResultV2[] = [];
  let maxActivePositionsObserved = 0;

  for (const episodeInput of ordered) {
    const capturedAtMs = Date.parse(episodeInput.episode.capturedAt);
    releaseClosedPositions(active, capturedAtMs, (released) => {
      realizedEquitySol += released.reservedSol + released.netPnlSol;
    });

    const dayKey = episodeInput.episode.capturedAt.slice(0, 10);
    const selected = episodeInput.episode.selected && episodeInput.episode.eligible;
    const positionSizeSol = finitePositiveOrThrow(episodeInput.positionSizeSol, 'positionSizeSol');

    if (!selected) {
      results.push(buildSkippedResult(episodeInput, terminalHorizon, 'not_selected'));
      continue;
    }
    if (positionSizeSol > account.maxPositionSol) {
      results.push(buildSkippedResult(episodeInput, terminalHorizon, 'position_size_exceeds_limit'));
      continue;
    }
    if (active.length >= account.maxActivePositions) {
      results.push(buildSkippedResult(episodeInput, terminalHorizon, 'max_active_positions_reached'));
      continue;
    }
    if ((dailyNewRiskSol[dayKey] ?? 0) + positionSizeSol > account.maxDailyNewRiskSol) {
      results.push(buildSkippedResult(episodeInput, terminalHorizon, 'daily_new_risk_limit_reached'));
      continue;
    }

    const availableSol = realizedEquitySol - reserveSol - sumActiveReservedSol(active);
    if (availableSol < positionSizeSol) {
      results.push(buildSkippedResult(episodeInput, terminalHorizon, 'insufficient_available_sol'));
      continue;
    }

    const episodeResult = simulateEconomicShadowEpisodeV2({
      ...episodeInput,
      terminalHorizon
    });
    results.push(episodeResult);

    if (episodeResult.status === 'simulated' && episodeResult.pnl) {
      dailyNewRiskSol[dayKey] = (dailyNewRiskSol[dayKey] ?? 0) + positionSizeSol;
      const terminalMark = terminalMarkFor(episodeInput.marks, terminalHorizon);
      active.push({
        closeAtMs: Date.parse(terminalMark?.targetAt ?? episodeInput.episode.labelWindowEndsAt),
        reservedSol: positionSizeSol,
        netPnlSol: episodeResult.pnl.netPnlSol
      });
      maxActivePositionsObserved = Math.max(maxActivePositionsObserved, active.length);
    }
  }

  releaseClosedPositions(active, Number.POSITIVE_INFINITY, (released) => {
    realizedEquitySol += released.reservedSol + released.netPnlSol;
  });

  const simulatedEpisodes = results.filter((result) => result.status === 'simulated');
  const totalNetPnlSol = simulatedEpisodes.reduce((total, result) => total + (result.pnl?.netPnlSol ?? 0), 0);
  const noRouteProbability = simulatedEpisodes.length === 0
    ? 0
    : simulatedEpisodes.filter((result) => result.terminalRouteStatus === 'no_route').length / simulatedEpisodes.length;

  return {
    schemaVersion: 2,
    mode: 'economic-shadow',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    startingSol: account.startingSol,
    endingEquitySol: realizedEquitySol,
    totalNetPnlSol,
    simulatedEpisodeCount: simulatedEpisodes.length,
    skippedEpisodeCount: results.length - simulatedEpisodes.length,
    maxActivePositionsObserved,
    dailyNewRiskSol,
    noRouteProbability,
    episodes: results
  };
}

export function simulateEconomicShadowEpisodeV2(
  input: EconomicShadowEpisodeInputV2 & { terminalHorizon?: ResearchHorizonV2 }
): EconomicShadowEpisodeResultV2 {
  const terminalHorizon = input.terminalHorizon ?? '24h';
  const terminalMark = terminalMarkFor(input.marks, terminalHorizon);
  if (!terminalMark) {
    return buildSkippedResult(input, terminalHorizon, 'missing_terminal_mark');
  }
  if (terminalMark.markStatus === 'missed') {
    return buildSkippedResult(input, terminalHorizon, 'missed_terminal_mark', terminalMark);
  }

  const positionSizeSol = finitePositiveOrThrow(input.positionSizeSol, 'positionSizeSol');
  const exitValueSol = markValueSol(terminalMark);
  const pathValues = input.marks
    .filter((mark) => mark.markStatus !== 'missed')
    .map((mark) => markValueSol(mark));
  const pathPnl = pathValues.map((value) => value - positionSizeSol);
  const roundTripCostSol = terminalMark.roundTripImpactBps === null
    ? 0
    : positionSizeSol * (terminalMark.roundTripImpactBps / 10_000);
  const feeIncomeSol = nonnegativeOrDefault(input.feeAccrualSol, 0, 'feeAccrualSol');
  const inventoryConversionSol = finiteOrDefault(input.inventoryConversionSol, 0, 'inventoryConversionSol');
  const impermanentLossSol = nonnegativeOrDefault(input.impermanentLossSol, 0, 'impermanentLossSol');
  const residualLiquidationImpactSol = finiteOrDefault(input.residualLiquidationImpactSol, 0, 'residualLiquidationImpactSol');
  const baseFeeSol = lamportsToSol(input.baseFeeLamports);
  const priorityFeeSol = lamportsToSol(input.priorityFeeLamports);
  const jitoTipSol = lamportsToSol(input.jitoTipLamports);
  const rentSol = lamportsToSol(input.rentLamports);
  const failedTransactionExpectedCostSol = nonnegativeOrDefault(input.failedTransactionProbability, 0, 'failedTransactionProbability')
    * nonnegativeOrDefault(input.failedTransactionCostSol, 0, 'failedTransactionCostSol');
  const principalChangeSol = exitValueSol - positionSizeSol;
  const grossPnlSol = principalChangeSol
    + feeIncomeSol
    + inventoryConversionSol
    - impermanentLossSol
    + residualLiquidationImpactSol;
  const netPnlSol = grossPnlSol
    - roundTripCostSol
    - baseFeeSol
    - priorityFeeSol
    - jitoTipSol
    - rentSol
    - failedTransactionExpectedCostSol;
  const pnl: EconomicShadowPnlBreakdownV2 = {
    principalChangeSol,
    feeIncomeSol,
    inventoryConversionSol,
    impermanentLossSol,
    roundTripCostSol,
    baseFeeSol,
    priorityFeeSol,
    jitoTipSol,
    rentSol,
    failedTransactionExpectedCostSol,
    residualLiquidationImpactSol,
    grossPnlSol,
    netPnlSol,
    afterCostReturnPct: netPnlSol / positionSizeSol,
    feeImpermanentLossRatio: impermanentLossSol > 0 ? feeIncomeSol / impermanentLossSol : null
  };
  const evidenceType: EconomicShadowEvidenceTypeV2 = typeof input.landingLatencyMs === 'number'
    ? 'simulated_transaction'
    : 'simulated_quote';

  return {
    schemaVersion: 2,
    simulationId: deterministicShadowId(input.episode.episodeId, terminalHorizon, input),
    mode: 'economic-shadow',
    episodeId: input.episode.episodeId,
    strategyId: input.episode.strategyId,
    tokenMint: input.episode.tokenMint,
    poolAddress: input.episode.poolAddress,
    selected: input.episode.selected,
    status: 'simulated',
    evidenceType,
    fillEvidenceType: evidenceType,
    terminalHorizon,
    terminalMarkId: terminalMark.markId,
    terminalMarkStatus: terminalMark.markStatus,
    terminalRouteStatus: terminalMark.routeStatus,
    positionSizeSol,
    exitValueSol,
    quoteAgeMs: terminalMark.quoteAgeMs,
    landingLatencyMs: input.landingLatencyMs ?? null,
    noRouteProbability: input.marks.length === 0
      ? 0
      : input.marks.filter((mark) => mark.routeStatus === 'no_route').length / input.marks.length,
    timeInRangePct: typeof input.timeInRangePct === 'number'
      ? clamp(input.timeInRangePct, 0, 1)
      : (terminalMark.markStatus === 'observed' ? 1 : 0),
    mfeSol: pathPnl.length > 0 ? Math.max(...pathPnl) : null,
    maeSol: pathPnl.length > 0 ? Math.min(...pathPnl) : null,
    capacityCurve: terminalMark.capacityCurve,
    pnl,
    benchmarks: buildBenchmarks({
      positionSizeSol,
      terminalValueSol: exitValueSol,
      netPnlSol,
      benchmarkValuesSol: input.benchmarkValuesSol
    })
  };
}

function buildBenchmarks(input: {
  positionSizeSol: number;
  terminalValueSol: number;
  netPnlSol: number;
  benchmarkValuesSol?: EconomicShadowEpisodeInputV2['benchmarkValuesSol'];
}): EconomicShadowBenchmarkV2[] {
  const defaults: Record<EconomicShadowBenchmarkNameV2, number> = {
    no_trade: input.positionSizeSol,
    hold_sol: input.positionSizeSol,
    direct_token: input.terminalValueSol,
    wide_range_lp: input.positionSizeSol + input.netPnlSol,
    current_strategy: input.positionSizeSol + input.netPnlSol,
    candidate_strategy: input.positionSizeSol + input.netPnlSol
  };
  const names: EconomicShadowBenchmarkNameV2[] = [
    'no_trade',
    'hold_sol',
    'direct_token',
    'wide_range_lp',
    'current_strategy',
    'candidate_strategy'
  ];

  return names.map((name) => {
    const terminalValueSol = input.benchmarkValuesSol?.[name as keyof typeof input.benchmarkValuesSol] ?? defaults[name];
    const netPnlSol = terminalValueSol - input.positionSizeSol;
    return {
      name,
      terminalValueSol,
      netPnlSol,
      afterCostReturnPct: netPnlSol / input.positionSizeSol
    };
  });
}

function terminalMarkFor(marks: ExecutableMarkV2[], horizon: ResearchHorizonV2) {
  return marks.find((mark) => mark.horizon === horizon) ?? null;
}

function markValueSol(mark: ExecutableMarkV2) {
  if (mark.markStatus === 'observed' && mark.executableValueSol !== null) {
    return mark.executableValueSol;
  }
  if (mark.markStatus === 'adverse' && mark.recoveryValueSol !== null) {
    return mark.recoveryValueSol;
  }
  throw new Error(`Cannot derive economic-shadow value from mark ${mark.markId} with status ${mark.markStatus}.`);
}

function buildSkippedResult(
  input: EconomicShadowEpisodeInputV2,
  terminalHorizon: ResearchHorizonV2,
  skipReason: EconomicShadowSkipReasonV2,
  terminalMark?: ExecutableMarkV2
): EconomicShadowEpisodeResultV2 {
  return {
    schemaVersion: 2,
    simulationId: deterministicShadowId(input.episode.episodeId, terminalHorizon, { skipReason }),
    mode: 'economic-shadow',
    episodeId: input.episode.episodeId,
    strategyId: input.episode.strategyId,
    tokenMint: input.episode.tokenMint,
    poolAddress: input.episode.poolAddress,
    selected: input.episode.selected,
    status: 'skipped',
    skipReason,
    evidenceType: 'simulated_quote',
    fillEvidenceType: 'simulated_quote',
    terminalHorizon,
    terminalMarkId: terminalMark?.markId ?? null,
    terminalMarkStatus: terminalMark?.markStatus ?? null,
    terminalRouteStatus: terminalMark?.routeStatus ?? null,
    positionSizeSol: input.positionSizeSol,
    exitValueSol: null,
    quoteAgeMs: terminalMark?.quoteAgeMs ?? null,
    landingLatencyMs: null,
    noRouteProbability: 0,
    timeInRangePct: null,
    mfeSol: null,
    maeSol: null,
    capacityCurve: [],
    pnl: null,
    benchmarks: []
  };
}

function normalizeAccount(account: EconomicShadowAccountConfigV2): Required<EconomicShadowAccountConfigV2> {
  return {
    startingSol: finitePositiveOrThrow(account.startingSol, 'startingSol'),
    solReserve: nonnegativeOrDefault(account.solReserve, 0, 'solReserve'),
    maxActivePositions: positiveIntegerOrThrow(account.maxActivePositions, 'maxActivePositions'),
    maxDailyNewRiskSol: finitePositiveOrThrow(account.maxDailyNewRiskSol, 'maxDailyNewRiskSol'),
    maxPositionSol: finitePositiveOrThrow(account.maxPositionSol, 'maxPositionSol'),
    terminalHorizon: account.terminalHorizon ?? '24h'
  };
}

function releaseClosedPositions(
  active: ActiveShadowPosition[],
  nowMs: number,
  onRelease: (position: ActiveShadowPosition) => void
) {
  for (let index = active.length - 1; index >= 0; index -= 1) {
    if (active[index].closeAtMs <= nowMs) {
      const [released] = active.splice(index, 1);
      onRelease(released);
    }
  }
}

function sumActiveReservedSol(active: ActiveShadowPosition[]) {
  return active.reduce((total, position) => total + position.reservedSol, 0);
}

function lamportsToSol(value: number | undefined) {
  return nonnegativeOrDefault(value, 0, 'lamports') / LAMPORTS_PER_SOL;
}

function finitePositiveOrThrow(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a finite positive number.`);
  }
  return value;
}

function positiveIntegerOrThrow(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function nonnegativeOrDefault(value: number | undefined, fallback: number, field: string) {
  if (typeof value === 'undefined') {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite nonnegative number.`);
  }
  return value;
}

function finiteOrDefault(value: number | undefined, fallback: number, field: string) {
  if (typeof value === 'undefined') {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite.`);
  }
  return value;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    throw new Error('timeInRangePct must be finite.');
  }
  return Math.min(max, Math.max(min, value));
}

function deterministicShadowId(episodeId: string, terminalHorizon: ResearchHorizonV2, payload: unknown) {
  const digest = createHash('sha256')
    .update(stableStringify({
      schemaVersion: 2,
      mode: 'economic-shadow',
      episodeId,
      terminalHorizon,
      payload
    }))
    .digest('hex')
    .slice(0, 32);
  return `economic-shadow-v2-${digest}`;
}
