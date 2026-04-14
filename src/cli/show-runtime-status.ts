import type { MirrorStatusExtras } from '../observability/mirror-query-service.ts';
import type { HealthReport } from '../runtime/state-types.ts';

export function formatRuntimeStatus(report: HealthReport & Partial<MirrorStatusExtras>) {
  const lines = [
    `mode=${report.mode}`,
    `allowNewOpens=${report.allowNewOpens}`,
    `flattenOnly=${report.flattenOnly}`,
    `pendingSubmission=${report.pendingSubmission}`,
    `circuitReason=${report.circuitReason}`,
    `lastSuccessfulTickAt=${report.lastSuccessfulTickAt}`,
    `quoteFailures=${report.dependencyHealth.quoteFailures}`,
    `reconcileFailures=${report.dependencyHealth.reconcileFailures}`,
    `updatedAt=${report.updatedAt}`
  ];

  if (report.housekeeping) {
    lines.push(
      `lastHousekeepingAt=${report.housekeeping.lastHousekeepingAt}`,
      `journalCleanupDeletedFiles=${report.housekeeping.journalCleanupDeletedFiles}`,
      `mirrorPruneDeletedRows=${report.housekeeping.mirrorPruneDeletedRows}`,
      `gmgnSafetyCacheEntries=${report.housekeeping.gmgnSafetyCacheEntries}`
    );

    if (report.housekeeping.lastCleanupError) {
      lines.push(`lastCleanupError=${report.housekeeping.lastCleanupError}`);
    }
  }

  if (report.mirror) {
    lines.push(
      `mirrorState=${report.mirror.state}`,
      `mirrorQueueDepth=${report.mirror.queueDepth}`,
      `mirrorDroppedEvents=${report.mirror.droppedEvents}`,
      `mirrorPath=${report.mirror.path}`
    );
  }

  if (report.recentIncidents && report.recentIncidents.length > 0) {
    lines.push(`recentIncidents=${report.recentIncidents.length}`);
  }

  if (report.recentOrders && report.recentOrders.length > 0) {
    lines.push(`recentOrders=${report.recentOrders.length}`);
  }

  return lines.join('\n');
}
