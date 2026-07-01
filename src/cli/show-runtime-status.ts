import type { MirrorStatusExtras } from '../observability/mirror-query-service.ts';
import type { HealthReport } from '../runtime/state-types.ts';

type EvolutionStatusSummary = {
  proposalCount: number;
  approvalQueueCount: number;
  outcomeReviewCount: number;
  latestEvidenceWindow: string;
};

export function formatRuntimeStatus(report: HealthReport & Partial<MirrorStatusExtras> & {
  evolution?: EvolutionStatusSummary;
}) {
  const lines = [
    `mode=${report.mode}`,
    `allowNewOpens=${report.allowNewOpens}`,
    `activeLpCount=${report.activeLpCount ?? 0}`,
    `chainActiveLpCount=${report.chainActiveLpCount ?? 0}`,
    `pendingOpenCount=${report.pendingOpenCount ?? 0}`,
    `reconcileRequiredCount=${report.reconcileRequiredCount ?? 0}`,
    `managedLpCount=${report.managedLpCount ?? 0}`,
    `untrackedLpCount=${report.untrackedLpCount ?? 0}`,
    `importFailedLpCount=${report.importFailedLpCount ?? 0}`,
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

  if (report.recentCandidateScans && report.recentCandidateScans.length > 0) {
    lines.push(`recentCandidateScans=${report.recentCandidateScans.length}`);
  }

  if (report.recentWatchlistSnapshots && report.recentWatchlistSnapshots.length > 0) {
    lines.push(`recentWatchlistSnapshots=${report.recentWatchlistSnapshots.length}`);
  }

  if (report.evolution) {
    lines.push(
      `evolutionProposalCount=${report.evolution.proposalCount}`,
      `evolutionApprovalQueueCount=${report.evolution.approvalQueueCount}`,
      `evolutionOutcomeReviewCount=${report.evolution.outcomeReviewCount}`,
      `evolutionLatestEvidenceWindow=${report.evolution.latestEvidenceWindow}`
    );
  }

  return lines.join('\n');
}
