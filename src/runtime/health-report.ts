import type {
  HealthReport,
  HousekeepingSnapshot,
  MirrorMetricsSnapshot,
  RuntimeMode
} from './state-types.ts';

export function buildHealthReport(input: {
  mode: RuntimeMode;
  allowNewOpens: boolean;
  activeLpCount?: number;
  managedLpCount?: number;
  untrackedLpCount?: number;
  importFailedLpCount?: number;
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
  staleAfterMs?: number;
}): HealthReport {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const staleAfterMs = input.staleAfterMs ?? 5 * 60_000;
  const tickAgeMs = Date.parse(updatedAt) - Date.parse(input.lastSuccessfulTickAt);
  const isStale = Number.isFinite(tickAgeMs) && tickAgeMs > staleAfterMs;

  return {
    mode: isStale && input.mode === 'healthy' ? 'degraded' : input.mode,
    allowNewOpens: isStale ? false : input.allowNewOpens,
    activeLpCount: input.activeLpCount,
    managedLpCount: input.managedLpCount,
    untrackedLpCount: input.untrackedLpCount,
    importFailedLpCount: input.importFailedLpCount,
    flattenOnly: input.flattenOnly,
    pendingSubmission: input.pendingSubmission,
    circuitReason: isStale && !input.circuitReason ? 'runtime-stale:last-successful-tick' : input.circuitReason,
    lastSuccessfulTickAt: input.lastSuccessfulTickAt,
    dependencyHealth: input.dependencyHealth,
    housekeeping: input.housekeeping,
    mirror: input.mirror,
    updatedAt
  };
}
