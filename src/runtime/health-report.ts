import type {
  HealthReport,
  HousekeepingSnapshot,
  MirrorMetricsSnapshot,
  RuntimeMode
} from './state-types.ts';

export function buildHealthReport(input: {
  mode: RuntimeMode;
  allowNewOpens: boolean;
  flattenOnly: boolean;
  pendingSubmission: boolean;
  circuitReason: string;
  lastSuccessfulTickAt: string;
  dependencyHealth: {
    quoteFailures: number;
    reconcileFailures: number;
  };
  housekeeping?: HousekeepingSnapshot;
  mirror?: MirrorMetricsSnapshot;
  updatedAt?: string;
}): HealthReport {
  return {
    mode: input.mode,
    allowNewOpens: input.allowNewOpens,
    flattenOnly: input.flattenOnly,
    pendingSubmission: input.pendingSubmission,
    circuitReason: input.circuitReason,
    lastSuccessfulTickAt: input.lastSuccessfulTickAt,
    dependencyHealth: input.dependencyHealth,
    housekeeping: input.housekeeping,
    mirror: input.mirror,
    updatedAt: input.updatedAt ?? new Date().toISOString()
  };
}
