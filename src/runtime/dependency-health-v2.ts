import { z } from 'zod';

import { RunModeV2Schema } from './run-manifest-v2.ts';

export const DEPENDENCY_KEYS_V2 = [
  'gmgnSafety',
  'candidateWorker',
  'rpcRead',
  'rpcWrite',
  'dlmmValuation',
  'buyRoute',
  'sellRoute',
  'signer',
  'broadcaster',
  'confirmation',
  'finality',
  'outboxBacklog',
  'reconciliation',
  'diskWal',
  'researchExporter',
  'restartCount',
  'dataFreshness'
] as const;

export const DependencyKeyV2Schema = z.enum(DEPENDENCY_KEYS_V2);
export const SourceQualityV2Schema = z.enum([
  'healthy',
  'degraded',
  'partial',
  'stale',
  'unavailable',
  'unknown'
]);

export const DependencyHealthObservationV2Schema = z.object({
  status: SourceQualityV2Schema,
  observedAt: z.string().datetime({ offset: true }),
  lastSuccessAt: z.string().datetime({ offset: true }).optional(),
  lastFailureAt: z.string().datetime({ offset: true }).optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  reason: z.string(),
  latencyMs: z.number().finite().nonnegative().optional(),
  value: z.number().finite().optional(),
  unit: z.string().min(1).optional(),
  threshold: z.number().finite().optional()
}).strict();

const DependencyHealthEntryV2Schema = DependencyHealthObservationV2Schema.extend({
  key: DependencyKeyV2Schema,
  criticalForNewOpens: z.boolean(),
  requiredForRiskReduction: z.boolean()
}).strict();

const DependencyHealthEntriesV2Schema = z.object({
  gmgnSafety: DependencyHealthEntryV2Schema,
  candidateWorker: DependencyHealthEntryV2Schema,
  rpcRead: DependencyHealthEntryV2Schema,
  rpcWrite: DependencyHealthEntryV2Schema,
  dlmmValuation: DependencyHealthEntryV2Schema,
  buyRoute: DependencyHealthEntryV2Schema,
  sellRoute: DependencyHealthEntryV2Schema,
  signer: DependencyHealthEntryV2Schema,
  broadcaster: DependencyHealthEntryV2Schema,
  confirmation: DependencyHealthEntryV2Schema,
  finality: DependencyHealthEntryV2Schema,
  outboxBacklog: DependencyHealthEntryV2Schema,
  reconciliation: DependencyHealthEntryV2Schema,
  diskWal: DependencyHealthEntryV2Schema,
  researchExporter: DependencyHealthEntryV2Schema,
  restartCount: DependencyHealthEntryV2Schema,
  dataFreshness: DependencyHealthEntryV2Schema
}).strict();

export const DependencyHealthSnapshotV2Schema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().min(1),
  configSnapshotId: z.string().min(1),
  mode: RunModeV2Schema,
  observedAt: z.string().datetime({ offset: true }),
  overallStatus: SourceQualityV2Schema,
  dependencies: DependencyHealthEntriesV2Schema,
  allowNewOpens: z.boolean(),
  allowRiskReduction: z.boolean(),
  blockingNewOpenDependencies: DependencyKeyV2Schema.array(),
  blockingRiskReductionDependencies: DependencyKeyV2Schema.array()
}).strict();

export type DependencyKeyV2 = z.infer<typeof DependencyKeyV2Schema>;
export type SourceQualityV2 = z.infer<typeof SourceQualityV2Schema>;
export type DependencyHealthObservationV2 = z.infer<typeof DependencyHealthObservationV2Schema>;
export type DependencyHealthSnapshotV2 = z.infer<typeof DependencyHealthSnapshotV2Schema>;

export function buildDiskWalHealthObservationV2(input: {
  observedAt: string;
  totalBytes: number;
  availableBytes: number;
  warningFraction?: number;
  haltFraction?: number;
}): DependencyHealthObservationV2 {
  const warningFraction = input.warningFraction ?? 0.70;
  const haltFraction = input.haltFraction ?? 0.85;
  if (
    !Number.isFinite(input.totalBytes)
    || input.totalBytes <= 0
    || !Number.isFinite(input.availableBytes)
    || input.availableBytes < 0
    || input.availableBytes > input.totalBytes
  ) {
    return DependencyHealthObservationV2Schema.parse({
      status: 'unavailable',
      observedAt: input.observedAt,
      consecutiveFailures: 1,
      reason: 'disk-usage-unavailable',
      threshold: haltFraction
    });
  }

  const usedFraction = 1 - (input.availableBytes / input.totalBytes);
  if (usedFraction >= haltFraction) {
    return DependencyHealthObservationV2Schema.parse({
      status: 'unavailable',
      observedAt: input.observedAt,
      consecutiveFailures: 1,
      reason: 'disk-usage-halt-threshold',
      value: usedFraction,
      unit: 'fraction',
      threshold: haltFraction
    });
  }
  if (usedFraction >= warningFraction) {
    return DependencyHealthObservationV2Schema.parse({
      status: 'degraded',
      observedAt: input.observedAt,
      consecutiveFailures: 0,
      reason: 'disk-usage-warning-threshold',
      value: usedFraction,
      unit: 'fraction',
      threshold: warningFraction
    });
  }

  return DependencyHealthObservationV2Schema.parse({
    status: 'healthy',
    observedAt: input.observedAt,
    consecutiveFailures: 0,
    reason: 'disk-usage-ok',
    value: usedFraction,
    unit: 'fraction',
    threshold: warningFraction
  });
}

const NEW_OPEN_CRITICAL = new Set<DependencyKeyV2>([
  'gmgnSafety',
  'candidateWorker',
  'rpcRead',
  'rpcWrite',
  'dlmmValuation',
  'buyRoute',
  'sellRoute',
  'signer',
  'broadcaster',
  'confirmation',
  'finality',
  'outboxBacklog',
  'reconciliation',
  'diskWal',
  'dataFreshness'
]);

const RISK_REDUCTION_REQUIRED = new Set<DependencyKeyV2>([
  'rpcRead',
  'rpcWrite',
  'sellRoute',
  'signer',
  'broadcaster',
  'confirmation',
  'finality',
  'outboxBacklog',
  'diskWal'
]);

const STATUS_SEVERITY: Record<SourceQualityV2, number> = {
  healthy: 0,
  degraded: 1,
  partial: 2,
  stale: 3,
  unknown: 4,
  unavailable: 5
};

export function buildDependencyHealthSnapshotV2(input: {
  runId: string;
  configSnapshotId: string;
  mode: z.infer<typeof RunModeV2Schema>;
  observedAt: string;
  dependencies: Record<DependencyKeyV2, DependencyHealthObservationV2>;
}): DependencyHealthSnapshotV2 {
  const dependencies = Object.fromEntries(DEPENDENCY_KEYS_V2.map((key) => {
    const observation = DependencyHealthObservationV2Schema.parse(input.dependencies[key]);
    return [key, {
      key,
      ...observation,
      criticalForNewOpens: NEW_OPEN_CRITICAL.has(key),
      requiredForRiskReduction: RISK_REDUCTION_REQUIRED.has(key)
    }];
  })) as z.infer<typeof DependencyHealthEntriesV2Schema>;

  // Strict parsing is intentional: a missing dependency is unknown, never healthy.
  const parsedDependencies = DependencyHealthEntriesV2Schema.parse(dependencies);
  const unhealthyKeys = DEPENDENCY_KEYS_V2.filter((key) => parsedDependencies[key].status !== 'healthy');
  const blockingNewOpenDependencies = unhealthyKeys.filter((key) => (
    input.mode === 'canary' || parsedDependencies[key].criticalForNewOpens
  ));
  const blockingRiskReductionDependencies = unhealthyKeys.filter(
    (key) => parsedDependencies[key].requiredForRiskReduction
  );
  const overallStatus = DEPENDENCY_KEYS_V2
    .map((key) => parsedDependencies[key].status)
    .reduce<SourceQualityV2>((worst, current) => (
      STATUS_SEVERITY[current] > STATUS_SEVERITY[worst] ? current : worst
    ), 'healthy');

  return DependencyHealthSnapshotV2Schema.parse({
    schemaVersion: 2,
    runId: input.runId,
    configSnapshotId: input.configSnapshotId,
    mode: input.mode,
    observedAt: input.observedAt,
    overallStatus,
    dependencies: parsedDependencies,
    allowNewOpens: blockingNewOpenDependencies.length === 0,
    allowRiskReduction: blockingRiskReductionDependencies.length === 0,
    blockingNewOpenDependencies,
    blockingRiskReductionDependencies
  });
}
