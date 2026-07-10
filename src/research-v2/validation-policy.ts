import {
  ValidationCoverageV2Schema,
  ValidationDataQualityV2Schema,
  ValidationMetricsV2Schema,
  ValidationReportV2Schema,
  type ValidationBlockingReasonV2,
  type ValidationCoverageV2,
  type ValidationDataQualityV2,
  type ValidationMetricsV2,
  type ValidationReportV2
} from './types.ts';

export const PROFESSIONAL_VALIDATION_FLOORS_V2 = Object.freeze({
  minimumIndependentEpisodes: 500,
  minimumNaturalDays: 60,
  minimumUntouchedOosEpisodes: 100,
  minimumMarketRegimes: 3,
  maximumPoolEpisodeContributionPct: 20,
  maximumPoolProfitContributionPct: 20,
  maximumDeployerEpisodeContributionPct: 20,
  maximumDeflatedSharpePValue: 0.05,
  maximumProbabilityOfBacktestOverfitting: 0.20
});

export type ProfessionalValidationInputV2 = {
  reportId: string;
  datasetId: string;
  hypothesisId: string;
  generatedAt: string;
  coverage: ValidationCoverageV2;
  dataQuality: ValidationDataQualityV2;
  metrics: ValidationMetricsV2 | null;
};

export function evaluateProfessionalValidationV2(
  input: ProfessionalValidationInputV2
): ValidationReportV2 {
  const coverage = ValidationCoverageV2Schema.parse(input.coverage);
  const dataQuality = ValidationDataQualityV2Schema.parse(input.dataQuality);
  const metrics = input.metrics === null ? null : ValidationMetricsV2Schema.parse(input.metrics);
  const dataReasons = evaluateCoverageAndDataQuality(coverage, dataQuality);

  if (dataReasons.length > 0) {
    return buildReport(input, coverage, dataQuality, metrics, 'no_action', dataReasons);
  }

  if (metrics === null) {
    return buildReport(input, coverage, dataQuality, null, 'no_action', ['missing_validation_metrics']);
  }

  const metricReasons = evaluateMetrics(metrics);
  if (metricReasons.length > 0) {
    return buildReport(input, coverage, dataQuality, metrics, 'rejected', metricReasons);
  }

  return buildReport(input, coverage, dataQuality, metrics, 'eligible_for_human_review', []);
}

function evaluateCoverageAndDataQuality(
  coverage: ValidationCoverageV2,
  quality: ValidationDataQualityV2
): ValidationBlockingReasonV2[] {
  const reasons: ValidationBlockingReasonV2[] = [];
  const floors = PROFESSIONAL_VALIDATION_FLOORS_V2;

  if (coverage.independentEpisodes < floors.minimumIndependentEpisodes) {
    reasons.push('insufficient_independent_episodes');
  }
  if (coverage.naturalDays < floors.minimumNaturalDays) {
    reasons.push('insufficient_natural_days');
  }
  if (coverage.untouchedOosEpisodes < floors.minimumUntouchedOosEpisodes) {
    reasons.push('insufficient_untouched_oos_episodes');
  }
  if (coverage.marketRegimes < floors.minimumMarketRegimes) {
    reasons.push('insufficient_market_regimes');
  }
  if (coverage.maxPoolEpisodeContributionPct > floors.maximumPoolEpisodeContributionPct) {
    reasons.push('pool_episode_concentration_too_high');
  }
  if (coverage.maxPoolProfitContributionPct > floors.maximumPoolProfitContributionPct) {
    reasons.push('pool_profit_concentration_too_high');
  }
  if (coverage.maxDeployerEpisodeContributionPct > floors.maximumDeployerEpisodeContributionPct) {
    reasons.push('deployer_episode_concentration_too_high');
  }
  if (quality.datasetSchemaVersion !== 2) {
    reasons.push('dataset_schema_not_v2');
  }
  if (quality.identityMismatchCount > 0) {
    reasons.push('identity_mismatch_detected');
  }
  if (quality.duplicatedOutcomeBindingCount > 0) {
    reasons.push('duplicated_outcome_binding_detected');
  }
  if (quality.invalidV1RowCount > 0) {
    reasons.push('contains_invalid_v1_rows');
  }
  if (quality.untrustedValuationCount > 0) {
    reasons.push('untrusted_valuation_detected');
  }
  if (quality.unknownTerminalOutcomeCount > 0) {
    reasons.push('unknown_terminal_outcome_detected');
  }
  if (quality.unreconciledLedgerDeltaSol !== 0) {
    reasons.push('unreconciled_ledger_delta_detected');
  }

  return reasons;
}

function evaluateMetrics(metrics: ValidationMetricsV2): ValidationBlockingReasonV2[] {
  const reasons: ValidationBlockingReasonV2[] = [];
  const floors = PROFESSIONAL_VALIDATION_FLOORS_V2;

  if (metrics.oosGeometricReturnLower95 <= 0) {
    reasons.push('oos_lower_confidence_bound_not_positive');
  }
  if (metrics.deflatedSharpePValue >= floors.maximumDeflatedSharpePValue) {
    reasons.push('deflated_sharpe_p_value_not_below_limit');
  }
  if (metrics.probabilityOfBacktestOverfitting >= floors.maximumProbabilityOfBacktestOverfitting) {
    reasons.push('pbo_not_below_limit');
  }
  if (metrics.candidateExpectedShortfall95 > metrics.baselineExpectedShortfall95) {
    reasons.push('expected_shortfall_95_worse_than_baseline');
  }
  if (metrics.candidateExpectedShortfall99 > metrics.baselineExpectedShortfall99) {
    reasons.push('expected_shortfall_99_worse_than_baseline');
  }
  if (metrics.candidateMaxDrawdownPct > metrics.baselineMaxDrawdownPct) {
    reasons.push('max_drawdown_worse_than_baseline');
  }
  if (!metrics.regimeDirectionConsistent) {
    reasons.push('regime_direction_inconsistent');
  }
  if (!metrics.targetSizeExitExecutable) {
    reasons.push('target_size_exit_not_executable');
  }
  if (!metrics.doubleSizeExitExecutable) {
    reasons.push('double_size_exit_not_executable');
  }

  return reasons;
}

function buildReport(
  input: ProfessionalValidationInputV2,
  coverage: ValidationCoverageV2,
  dataQuality: ValidationDataQualityV2,
  metrics: ValidationMetricsV2 | null,
  status: ValidationReportV2['status'],
  blockingReasons: ValidationBlockingReasonV2[]
) {
  return ValidationReportV2Schema.parse({
    schemaVersion: 2,
    policyVersion: 'professional-v2',
    reportId: input.reportId,
    datasetId: input.datasetId,
    hypothesisId: input.hypothesisId,
    generatedAt: input.generatedAt,
    status,
    proposalAllowed: status === 'eligible_for_human_review',
    coverage,
    dataQuality,
    metrics,
    blockingReasons
  });
}
