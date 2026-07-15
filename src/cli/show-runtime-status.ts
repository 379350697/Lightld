import type { MirrorStatusExtras } from '../observability/mirror-query-service.ts';
import type { HealthReport } from '../runtime/state-types.ts';

type ResearchStatusSummary = {
  activeExperiment?: { experimentId?: string } | null;
  latestExperiment?: { experimentId?: string } | null;
  experimentStatus?: string;
  snapshotCount?: number;
  episodeCount?: number;
  selectedEpisodeCount?: number;
  paperOutcomeCount?: number;
  marks?: Record<string, number>;
  worker?: { status?: string; heartbeatAt?: string } | null;
};

export function formatRuntimeStatus(report: HealthReport & Partial<MirrorStatusExtras> & {
  research?: ResearchStatusSummary | null;
}) {
  const lines = [
    `mode=${report.mode}`,
    `allowNewOpens=${report.allowNewOpens}`,
    `activeLpCount=${report.activeLpCount ?? 0}`,
    `chainActiveLpCount=${report.chainActiveLpCount ?? 0}`,
    `pendingOpenCount=${report.pendingOpenCount ?? 0}`,
    `reconcileRequiredCount=${report.reconcileRequiredCount ?? 0}`,
    `residualCleanupRequiredCount=${report.residualCleanupRequiredCount ?? 0}`,
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

  if (report.research) {
    lines.push(
      `researchExperiment=${report.research.activeExperiment?.experimentId ?? report.research.latestExperiment?.experimentId ?? 'none'}`,
      `researchExperimentStatus=${report.research.experimentStatus ?? 'none'}`,
      `researchSnapshotCount=${report.research.snapshotCount ?? 0}`,
      `researchEpisodeCount=${report.research.episodeCount ?? 0}`,
      `researchSelectedEpisodeCount=${report.research.selectedEpisodeCount ?? 0}`,
      `researchPaperOutcomeCount=${report.research.paperOutcomeCount ?? 0}`,
      `researchMark15m=${report.research.marks?.['15'] ?? 0}`,
      `researchMark1h=${report.research.marks?.['60'] ?? 0}`,
      `researchMark4h=${report.research.marks?.['240'] ?? 0}`,
      `researchMark24h=${report.research.marks?.['1440'] ?? 0}`,
      `researchWorkerStatus=${report.research.worker?.status ?? 'not-running'}`,
      `researchWorkerHeartbeat=${report.research.worker?.heartbeatAt ?? ''}`
    );
  }

  return lines.join('\n');
}
