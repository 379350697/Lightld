import { z } from 'zod';

import { RunModeV2Schema, type RunModeV2 } from './run-manifest-v2.ts';

export const EXECUTION_SLO_LIMITS_V2 = Object.freeze({
  failureTaxonomyCompletenessPct: 100,
  unknownTerminalOutcomeCount: 0,
  identityMismatchCount: 0,
  unexplainedReconciliationDeltaCount: 0,
  quoteToLandP95Ms: 10_000,
  landToFinalizedP95Ms: 60_000,
  landingRatePct: 90,
  signedEnvelopeBreachCount: 0
});

export const ExecutionSloObservationV2Schema = z.object({
  mode: RunModeV2Schema,
  orderId: z.string().min(1),
  executable: z.boolean(),
  safetyRejected: z.boolean(),
  landed: z.boolean(),
  finalized: z.boolean(),
  terminalOutcome: z.enum([
    'not_submitted',
    'landed',
    'confirmed',
    'finalized',
    'failed_terminal',
    'unknown'
  ]),
  failureOccurred: z.boolean(),
  failureKind: z.string().min(1).optional(),
  failureOperation: z.string().min(1).optional(),
  failureReason: z.string().min(1).optional(),
  identityMismatch: z.boolean(),
  unexplainedReconciliationDelta: z.boolean(),
  quoteToLandMs: z.number().finite().nonnegative().optional(),
  landToFinalizedMs: z.number().finite().nonnegative().optional(),
  signedMaxSlippageBps: z.number().finite().nonnegative().optional(),
  actualSlippageBps: z.number().finite().optional(),
  signedMaxImpactBps: z.number().finite().nonnegative().optional(),
  actualImpactBps: z.number().finite().nonnegative().optional(),
  signedMaxTotalFeeLamports: z.number().int().nonnegative().optional(),
  actualTotalFeeLamports: z.number().int().nonnegative().optional()
}).strict();

export const ExecutionSloModeReportV2Schema = z.object({
  mode: RunModeV2Schema,
  observationCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  completeFailureTaxonomyCount: z.number().int().nonnegative(),
  failureTaxonomyCompletenessPct: z.number().finite().min(0).max(100),
  unknownTerminalOutcomeCount: z.number().int().nonnegative(),
  identityMismatchCount: z.number().int().nonnegative(),
  unexplainedReconciliationDeltaCount: z.number().int().nonnegative(),
  landingEligibleCount: z.number().int().nonnegative(),
  landedCount: z.number().int().nonnegative(),
  landingRatePct: z.number().finite().min(0).max(100).nullable(),
  quoteToLandMeasuredCount: z.number().int().nonnegative(),
  quoteToLandP95Ms: z.number().finite().nonnegative().nullable(),
  finalizedCount: z.number().int().nonnegative(),
  finalityLatencyMeasuredCount: z.number().int().nonnegative(),
  landToFinalizedP95Ms: z.number().finite().nonnegative().nullable(),
  signedEnvelopeMeasuredCount: z.number().int().nonnegative(),
  signedEnvelopeMissingCount: z.number().int().nonnegative(),
  signedEnvelopeBreachCount: z.number().int().nonnegative(),
  status: z.enum(['pass', 'fail', 'insufficient_data']),
  violations: z.array(z.string().min(1))
}).strict();

export const ExecutionSloReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().datetime({ offset: true }),
  limits: z.object({
    failureTaxonomyCompletenessPct: z.literal(100),
    unknownTerminalOutcomeCount: z.literal(0),
    identityMismatchCount: z.literal(0),
    unexplainedReconciliationDeltaCount: z.literal(0),
    quoteToLandP95Ms: z.literal(10_000),
    landToFinalizedP95Ms: z.literal(60_000),
    landingRatePct: z.literal(90),
    signedEnvelopeBreachCount: z.literal(0)
  }).strict(),
  modes: ExecutionSloModeReportV2Schema.array()
}).strict();

export type ExecutionSloObservationV2 = z.infer<typeof ExecutionSloObservationV2Schema>;
export type ExecutionSloModeReportV2 = z.infer<typeof ExecutionSloModeReportV2Schema>;
export type ExecutionSloReportV2 = z.infer<typeof ExecutionSloReportV2Schema>;

const MODE_ORDER: RunModeV2[] = ['mechanical-soak', 'economic-shadow', 'canary', 'live'];

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function hasCompleteFailureTaxonomy(observation: ExecutionSloObservationV2) {
  return Boolean(
    observation.failureKind
    && observation.failureOperation
    && observation.failureReason
  );
}

function hasCompleteEnvelope(observation: ExecutionSloObservationV2) {
  return observation.signedMaxSlippageBps !== undefined
    && observation.actualSlippageBps !== undefined
    && observation.signedMaxImpactBps !== undefined
    && observation.actualImpactBps !== undefined
    && observation.signedMaxTotalFeeLamports !== undefined
    && observation.actualTotalFeeLamports !== undefined;
}

function breachesEnvelope(observation: ExecutionSloObservationV2) {
  if (!hasCompleteEnvelope(observation)) return false;
  return observation.actualSlippageBps! > observation.signedMaxSlippageBps!
    || observation.actualImpactBps! > observation.signedMaxImpactBps!
    || observation.actualTotalFeeLamports! > observation.signedMaxTotalFeeLamports!;
}

function summarizeMode(
  mode: RunModeV2,
  observations: ExecutionSloObservationV2[]
): ExecutionSloModeReportV2 {
  const failures = observations.filter((observation) => observation.failureOccurred);
  const completeFailureTaxonomyCount = failures.filter(hasCompleteFailureTaxonomy).length;
  const failureTaxonomyCompletenessPct = failures.length === 0
    ? 100
    : (completeFailureTaxonomyCount / failures.length) * 100;
  const landingEligible = observations.filter(
    (observation) => observation.executable && !observation.safetyRejected
  );
  const landed = landingEligible.filter((observation) => observation.landed);
  const finalized = landingEligible.filter((observation) => observation.finalized);
  const quoteToLandValues = landed.flatMap((observation) => (
    observation.quoteToLandMs === undefined ? [] : [observation.quoteToLandMs]
  ));
  const landToFinalizedValues = finalized.flatMap((observation) => (
    observation.landToFinalizedMs === undefined ? [] : [observation.landToFinalizedMs]
  ));
  const envelopeMeasured = landingEligible.filter(hasCompleteEnvelope);
  const envelopeBreaches = envelopeMeasured.filter(breachesEnvelope);
  const quoteToLandP95Ms = percentile95(quoteToLandValues);
  const landToFinalizedP95Ms = percentile95(landToFinalizedValues);
  const landingRatePct = landingEligible.length === 0
    ? null
    : (landed.length / landingEligible.length) * 100;
  const unknownTerminalOutcomeCount = observations.filter(
    (observation) => observation.terminalOutcome === 'unknown'
  ).length;
  const identityMismatchCount = observations.filter((observation) => observation.identityMismatch).length;
  const unexplainedReconciliationDeltaCount = observations.filter(
    (observation) => observation.unexplainedReconciliationDelta
  ).length;
  const signedEnvelopeMissingCount = landingEligible.length - envelopeMeasured.length;
  const violations: string[] = [];

  if (failureTaxonomyCompletenessPct < EXECUTION_SLO_LIMITS_V2.failureTaxonomyCompletenessPct) {
    violations.push('failure-taxonomy-incomplete');
  }
  if (unknownTerminalOutcomeCount > 0) violations.push('unknown-terminal-outcome');
  if (identityMismatchCount > 0) violations.push('identity-mismatch');
  if (unexplainedReconciliationDeltaCount > 0) violations.push('unexplained-reconciliation-delta');
  if (landingRatePct !== null && landingRatePct < EXECUTION_SLO_LIMITS_V2.landingRatePct) {
    violations.push('landing-rate-below-slo');
  }
  if (quoteToLandP95Ms !== null && quoteToLandP95Ms > EXECUTION_SLO_LIMITS_V2.quoteToLandP95Ms) {
    violations.push('quote-to-land-p95-exceeded');
  }
  if (
    landToFinalizedP95Ms !== null
    && landToFinalizedP95Ms > EXECUTION_SLO_LIMITS_V2.landToFinalizedP95Ms
  ) {
    violations.push('land-to-finalized-p95-exceeded');
  }
  if (landed.length !== quoteToLandValues.length) violations.push('quote-to-land-measurement-missing');
  if (finalized.length !== landToFinalizedValues.length) violations.push('finality-latency-measurement-missing');
  if (signedEnvelopeMissingCount > 0) violations.push('signed-envelope-measurement-missing');
  if (envelopeBreaches.length > 0) violations.push('signed-envelope-breach');

  const insufficientData = landingEligible.length === 0 || landed.length === 0 || finalized.length === 0;
  const status = violations.length > 0
    ? 'fail'
    : insufficientData
      ? 'insufficient_data'
      : 'pass';

  return ExecutionSloModeReportV2Schema.parse({
    mode,
    observationCount: observations.length,
    failureCount: failures.length,
    completeFailureTaxonomyCount,
    failureTaxonomyCompletenessPct,
    unknownTerminalOutcomeCount,
    identityMismatchCount,
    unexplainedReconciliationDeltaCount,
    landingEligibleCount: landingEligible.length,
    landedCount: landed.length,
    landingRatePct,
    quoteToLandMeasuredCount: quoteToLandValues.length,
    quoteToLandP95Ms,
    finalizedCount: finalized.length,
    finalityLatencyMeasuredCount: landToFinalizedValues.length,
    landToFinalizedP95Ms,
    signedEnvelopeMeasuredCount: envelopeMeasured.length,
    signedEnvelopeMissingCount,
    signedEnvelopeBreachCount: envelopeBreaches.length,
    status,
    violations
  });
}

export function aggregateExecutionSloV2(
  rawObservations: z.input<typeof ExecutionSloObservationV2Schema>[],
  generatedAt = new Date().toISOString()
): ExecutionSloReportV2 {
  const observations = rawObservations.map((observation) => ExecutionSloObservationV2Schema.parse(observation));
  const modes = MODE_ORDER.flatMap((mode) => {
    const modeObservations = observations.filter((observation) => observation.mode === mode);
    return modeObservations.length === 0 ? [] : [summarizeMode(mode, modeObservations)];
  });

  // There is deliberately no combined rollup: cross-mode aggregation would mix
  // synthetic, simulated and funded execution evidence.
  return ExecutionSloReportV2Schema.parse({
    schemaVersion: 2,
    generatedAt,
    limits: EXECUTION_SLO_LIMITS_V2,
    modes
  });
}
