import { z } from 'zod';

const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IsoDateTimeSchema = z.string().refine(
  (value) => ISO_DATE_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value)),
  'Expected an ISO-8601 date-time.'
);

const NonEmptyIdSchema = z.string().trim().min(1);
const NullableNonnegativeNumberSchema = z.number().finite().nonnegative().nullable();
const DAY_MS = 24 * 60 * 60 * 1000;
const HORIZON_TOLERANCE_MS: Record<'15m' | '1h' | '4h' | '24h', number> = {
  '15m': 2 * 60 * 1000,
  '1h': 5 * 60 * 1000,
  '4h': 15 * 60 * 1000,
  '24h': 60 * 60 * 1000
};

export const ResearchStrategyIdV2Schema = z.enum(['new-token-v1', 'large-pool-v1']);
export type ResearchStrategyIdV2 = z.infer<typeof ResearchStrategyIdV2Schema>;

export const ResearchFeatureValueV2Schema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null()
]);
export type ResearchFeatureValueV2 = z.infer<typeof ResearchFeatureValueV2Schema>;

export const ResearchSourceObservationV2Schema = z.object({
  source: NonEmptyIdSchema,
  status: z.enum(['passed', 'blocked', 'failed', 'missing', 'stale', 'not_applicable']),
  observedAt: IsoDateTimeSchema,
  freshnessMs: z.number().finite().nonnegative(),
  details: z.record(z.string(), ResearchFeatureValueV2Schema).default({})
});
export type ResearchSourceObservationV2 = z.infer<typeof ResearchSourceObservationV2Schema>;

const OpportunityIdentityV2Schema = z.object({
  runId: NonEmptyIdSchema,
  strategyId: ResearchStrategyIdV2Schema,
  tokenMint: NonEmptyIdSchema,
  tokenSymbol: z.string(),
  poolAddress: NonEmptyIdSchema,
  deployerAddress: z.string().nullable(),
  configSnapshotId: NonEmptyIdSchema,
  policyVariantId: NonEmptyIdSchema
});

export const CandidateOpportunityObservationV2Schema = OpportunityIdentityV2Schema.extend({
  observationId: NonEmptyIdSchema,
  observedAt: IsoDateTimeSchema,
  eligible: z.boolean(),
  selected: z.boolean(),
  hardRejectionReasons: z.array(NonEmptyIdSchema),
  softRejectionReasons: z.array(NonEmptyIdSchema),
  pointInTimeFeatures: z.record(z.string(), ResearchFeatureValueV2Schema),
  sourceObservations: z.array(ResearchSourceObservationV2Schema)
}).superRefine((value, context) => {
  if (value.selected && !value.eligible) {
    context.addIssue({
      code: 'custom',
      path: ['selected'],
      message: 'A selected opportunity must be eligible.'
    });
  }
});
export type CandidateOpportunityObservationV2 = z.infer<typeof CandidateOpportunityObservationV2Schema>;

export const OpportunityEpisodeV2Schema = OpportunityIdentityV2Schema.extend({
  schemaVersion: z.literal(2),
  episodeId: NonEmptyIdSchema,
  capturedAt: IsoDateTimeSchema,
  labelWindowEndsAt: IsoDateTimeSchema,
  eligible: z.boolean(),
  selected: z.boolean(),
  hardRejectionReasons: z.array(NonEmptyIdSchema),
  softRejectionReasons: z.array(NonEmptyIdSchema),
  pointInTimeFeatures: z.record(z.string(), ResearchFeatureValueV2Schema),
  sourceObservations: z.array(ResearchSourceObservationV2Schema)
}).superRefine((value, context) => {
  if (Date.parse(value.labelWindowEndsAt) - Date.parse(value.capturedAt) !== DAY_MS) {
    context.addIssue({
      code: 'custom',
      path: ['labelWindowEndsAt'],
      message: 'An opportunity episode must use the fixed 24 hour label window.'
    });
  }

  if (value.selected && !value.eligible) {
    context.addIssue({
      code: 'custom',
      path: ['selected'],
      message: 'A selected episode must be eligible.'
    });
  }
});
export type OpportunityEpisodeV2 = z.infer<typeof OpportunityEpisodeV2Schema>;

export const ResearchHorizonV2Schema = z.enum(['15m', '1h', '4h', '24h']);
export type ResearchHorizonV2 = z.infer<typeof ResearchHorizonV2Schema>;

export const CapacityPointV2Schema = z.object({
  inputSol: z.number().finite().positive(),
  outputSol: z.number().finite().nonnegative(),
  impactBps: z.number().finite().nonnegative()
});
export type CapacityPointV2 = z.infer<typeof CapacityPointV2Schema>;

export const ExecutableMarkV2Schema = z.object({
  schemaVersion: z.literal(2),
  markId: NonEmptyIdSchema,
  episodeId: NonEmptyIdSchema,
  strategyId: ResearchStrategyIdV2Schema,
  tokenMint: NonEmptyIdSchema,
  poolAddress: NonEmptyIdSchema,
  horizon: ResearchHorizonV2Schema,
  targetAt: IsoDateTimeSchema,
  observedAt: IsoDateTimeSchema.nullable(),
  timingDeltaMs: z.number().finite().nullable(),
  toleranceMs: z.number().int().positive(),
  timingClassification: z.enum(['within_tolerance', 'missed']),
  markStatus: z.enum(['observed', 'adverse', 'missed']),
  routeStatus: z.enum(['available', 'no_route', 'dead_pool', 'rug', 'unknown']),
  executableValueSol: NullableNonnegativeNumberSchema,
  recoveryValueSol: NullableNonnegativeNumberSchema,
  adverseReason: z.enum(['no_route', 'dead_pool', 'rug']).nullable(),
  buyRouteAvailable: z.boolean(),
  sellRouteAvailable: z.boolean(),
  quoteSlot: z.number().int().nonnegative().nullable(),
  quoteAgeMs: z.number().finite().nonnegative().nullable(),
  roundTripImpactBps: z.number().finite().nonnegative().nullable(),
  capacityCurve: z.array(CapacityPointV2Schema)
}).superRefine((value, context) => {
  const expectedToleranceMs = HORIZON_TOLERANCE_MS[value.horizon];
  if (value.toleranceMs !== expectedToleranceMs) {
    context.addIssue({
      code: 'custom',
      path: ['toleranceMs'],
      message: 'Tolerance must match the fixed research horizon policy.'
    });
  }

  if ((value.observedAt === null) !== (value.timingDeltaMs === null)) {
    context.addIssue({
      code: 'custom',
      path: ['timingDeltaMs'],
      message: 'Observed time and timing delta must either both be present or both be absent.'
    });
  }

  if (value.observedAt !== null && value.timingDeltaMs !== null) {
    const actualDeltaMs = Date.parse(value.observedAt) - Date.parse(value.targetAt);
    if (actualDeltaMs !== value.timingDeltaMs) {
      context.addIssue({
        code: 'custom',
        path: ['timingDeltaMs'],
        message: 'Timing delta must equal observed time minus target time.'
      });
    }
    const expectedClassification = Math.abs(actualDeltaMs) <= expectedToleranceMs
      ? 'within_tolerance'
      : 'missed';
    if (value.timingClassification !== expectedClassification) {
      context.addIssue({
        code: 'custom',
        path: ['timingClassification'],
        message: 'Timing classification must be derived from the fixed tolerance.'
      });
    }
  }

  if (value.markStatus === 'missed') {
    if (value.timingClassification !== 'missed') {
      context.addIssue({ code: 'custom', path: ['timingClassification'], message: 'A missed mark must be outside tolerance.' });
    }
    if (value.executableValueSol !== null || value.recoveryValueSol !== null || value.capacityCurve.length > 0) {
      context.addIssue({ code: 'custom', path: ['markStatus'], message: 'A missed mark cannot carry an outcome value.' });
    }
    return;
  }

  if (value.timingClassification !== 'within_tolerance' || value.observedAt === null) {
    context.addIssue({ code: 'custom', path: ['timingClassification'], message: 'Observed outcomes must be within horizon tolerance.' });
  }

  if (value.markStatus === 'adverse') {
    if (
      value.routeStatus === 'available'
      || value.routeStatus === 'unknown'
      || value.adverseReason !== value.routeStatus
      || value.recoveryValueSol !== 0
      || value.executableValueSol !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['recoveryValueSol'],
        message: 'An adverse no-route/dead-pool/rug outcome must use zero recovery.'
      });
    }
    return;
  }

  if (
    value.routeStatus !== 'available'
    || value.executableValueSol === null
    || value.recoveryValueSol !== null
    || value.adverseReason !== null
    || !value.buyRouteAvailable
    || !value.sellRouteAvailable
    || value.quoteSlot === null
    || value.quoteAgeMs === null
    || value.roundTripImpactBps === null
    || value.capacityCurve.length === 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['routeStatus'],
      message: 'An observed mark requires executable two-sided route evidence.'
    });
  }
});
export type ExecutableMarkV2 = z.infer<typeof ExecutableMarkV2Schema>;

export const ExperimentWindowV2Schema = z.object({
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema
}).superRefine((value, context) => {
  if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'Experiment window must end after it starts.' });
  }
});
export type ExperimentWindowV2 = z.infer<typeof ExperimentWindowV2Schema>;

export const ExperimentRegistryV2Schema = z.object({
  schemaVersion: z.literal(2),
  hypothesisId: NonEmptyIdSchema,
  strategyId: ResearchStrategyIdV2Schema,
  hypothesis: NonEmptyIdSchema,
  parameterFamily: NonEmptyIdSchema,
  treatmentVariants: z.array(NonEmptyIdSchema).min(2),
  minimumDetectableEffect: z.number().finite().positive(),
  powerTarget: z.number().finite().gt(0).lt(1),
  testedVariantCount: z.number().int().min(2),
  trainWindow: ExperimentWindowV2Schema,
  validationWindow: ExperimentWindowV2Schema,
  oosWindow: ExperimentWindowV2Schema,
  purgeHours: z.number().finite().min(24),
  embargoHours: z.number().finite().min(24),
  acceptanceMetrics: z.array(NonEmptyIdSchema).min(1),
  createdAt: IsoDateTimeSchema,
  locked: z.literal(true)
}).superRefine((value, context) => {
  if (new Set(value.treatmentVariants).size !== value.treatmentVariants.length) {
    context.addIssue({ code: 'custom', path: ['treatmentVariants'], message: 'Treatment variants must be unique.' });
  }
  if (value.testedVariantCount !== value.treatmentVariants.length) {
    context.addIssue({ code: 'custom', path: ['testedVariantCount'], message: 'Tested variant count must match registered variants.' });
  }
  const trainValidationGapMs = Date.parse(value.validationWindow.startsAt) - Date.parse(value.trainWindow.endsAt);
  const validationOosGapMs = Date.parse(value.oosWindow.startsAt) - Date.parse(value.validationWindow.endsAt);
  if (trainValidationGapMs < value.purgeHours * 60 * 60 * 1000) {
    context.addIssue({
      code: 'custom',
      path: ['validationWindow'],
      message: 'The train-to-validation gap must satisfy the registered purge.'
    });
  }
  if (validationOosGapMs < value.embargoHours * 60 * 60 * 1000) {
    context.addIssue({
      code: 'custom',
      path: ['oosWindow'],
      message: 'The validation-to-OOS gap must satisfy the registered embargo.'
    });
  }
});
export type ExperimentRegistryV2 = z.infer<typeof ExperimentRegistryV2Schema>;

export const ValidationCoverageV2Schema = z.object({
  independentEpisodes: z.number().int().nonnegative(),
  naturalDays: z.number().int().nonnegative(),
  untouchedOosEpisodes: z.number().int().nonnegative(),
  marketRegimes: z.number().int().nonnegative(),
  maxPoolEpisodeContributionPct: z.number().finite().min(0).max(100),
  maxPoolProfitContributionPct: z.number().finite().min(0).max(100),
  maxDeployerEpisodeContributionPct: z.number().finite().min(0).max(100)
});
export type ValidationCoverageV2 = z.infer<typeof ValidationCoverageV2Schema>;

export const ValidationDataQualityV2Schema = z.object({
  datasetSchemaVersion: z.number().int().nonnegative(),
  identityMismatchCount: z.number().int().nonnegative(),
  duplicatedOutcomeBindingCount: z.number().int().nonnegative(),
  invalidV1RowCount: z.number().int().nonnegative(),
  untrustedValuationCount: z.number().int().nonnegative(),
  unknownTerminalOutcomeCount: z.number().int().nonnegative(),
  unreconciledLedgerDeltaSol: z.number().finite()
});
export type ValidationDataQualityV2 = z.infer<typeof ValidationDataQualityV2Schema>;

export const ValidationMetricsV2Schema = z.object({
  afterCostArithmeticReturn: z.number().finite(),
  afterCostGeometricReturn: z.number().finite(),
  medianReturn: z.number().finite(),
  trimmedMeanReturn: z.number().finite(),
  profitFactor: z.number().finite().nonnegative().nullable(),
  sortinoRatio: z.number().finite().nullable(),
  calmarRatio: z.number().finite().nullable(),
  oosGeometricReturnLower95: z.number().finite(),
  deflatedSharpePValue: z.number().finite().min(0).max(1),
  probabilityOfBacktestOverfitting: z.number().finite().min(0).max(1),
  hansenSpaPValue: z.number().finite().min(0).max(1),
  bhFdrQValue: z.number().finite().min(0).max(1),
  candidateExpectedShortfall95: z.number().finite().nonnegative(),
  baselineExpectedShortfall95: z.number().finite().nonnegative(),
  candidateExpectedShortfall99: z.number().finite().nonnegative(),
  baselineExpectedShortfall99: z.number().finite().nonnegative(),
  candidateMaxDrawdownPct: z.number().finite().nonnegative(),
  baselineMaxDrawdownPct: z.number().finite().nonnegative(),
  lossClusteringScore: z.number().finite().min(0).max(1),
  ruinProbability: z.number().finite().min(0).max(1),
  capacityDecayAtDoubleSizePct: z.number().finite(),
  regimeDirectionConsistent: z.boolean(),
  targetSizeExitExecutable: z.boolean(),
  doubleSizeExitExecutable: z.boolean()
});
export type ValidationMetricsV2 = z.infer<typeof ValidationMetricsV2Schema>;

export const ValidationBlockingReasonV2Schema = z.enum([
  'insufficient_independent_episodes',
  'insufficient_natural_days',
  'insufficient_untouched_oos_episodes',
  'insufficient_market_regimes',
  'pool_episode_concentration_too_high',
  'pool_profit_concentration_too_high',
  'deployer_episode_concentration_too_high',
  'dataset_schema_not_v2',
  'identity_mismatch_detected',
  'duplicated_outcome_binding_detected',
  'contains_invalid_v1_rows',
  'untrusted_valuation_detected',
  'unknown_terminal_outcome_detected',
  'unreconciled_ledger_delta_detected',
  'missing_validation_metrics',
  'oos_lower_confidence_bound_not_positive',
  'deflated_sharpe_p_value_not_below_limit',
  'pbo_not_below_limit',
  'expected_shortfall_95_worse_than_baseline',
  'expected_shortfall_99_worse_than_baseline',
  'max_drawdown_worse_than_baseline',
  'regime_direction_inconsistent',
  'target_size_exit_not_executable',
  'double_size_exit_not_executable'
]);
export type ValidationBlockingReasonV2 = z.infer<typeof ValidationBlockingReasonV2Schema>;

export const ValidationReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  policyVersion: z.literal('professional-v2'),
  reportId: NonEmptyIdSchema,
  datasetId: NonEmptyIdSchema,
  hypothesisId: NonEmptyIdSchema,
  generatedAt: IsoDateTimeSchema,
  status: z.enum(['eligible_for_human_review', 'no_action', 'rejected']),
  proposalAllowed: z.boolean(),
  coverage: ValidationCoverageV2Schema,
  dataQuality: ValidationDataQualityV2Schema,
  metrics: ValidationMetricsV2Schema.nullable(),
  blockingReasons: z.array(ValidationBlockingReasonV2Schema)
}).superRefine((value, context) => {
  const eligible = value.status === 'eligible_for_human_review';
  if (value.proposalAllowed !== eligible) {
    context.addIssue({
      code: 'custom',
      path: ['proposalAllowed'],
      message: 'Only an eligible-for-human-review report may allow a proposal.'
    });
  }
  if (eligible && (value.blockingReasons.length > 0 || value.metrics === null)) {
    context.addIssue({
      code: 'custom',
      path: ['blockingReasons'],
      message: 'An eligible report must have metrics and no blocking reasons.'
    });
  }
  if (!eligible && value.blockingReasons.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['blockingReasons'],
      message: 'A no-action or rejected report must state at least one blocking reason.'
    });
  }
  if (value.status === 'rejected' && value.metrics === null) {
    context.addIssue({
      code: 'custom',
      path: ['metrics'],
      message: 'A statistical rejection must include the evaluated metrics.'
    });
  }
});
export type ValidationReportV2 = z.infer<typeof ValidationReportV2Schema>;
