import type { MirrorStatusExtras } from '../observability/mirror-query-service.ts';
import type { ProfessionalRuntimeStatusV2 } from '../runtime/professional-runtime-status-v2.ts';
import type { HealthReport } from '../runtime/state-types.ts';

type EvolutionStatusSummary = {
  proposalCount: number;
  approvalQueueCount: number;
  outcomeReviewCount: number;
  latestEvidenceWindow: string;
};

export function formatRuntimeStatus(report: HealthReport & Partial<MirrorStatusExtras> & {
  evolution?: EvolutionStatusSummary;
  professionalV2?: ProfessionalRuntimeStatusV2 | null;
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

  if (report.evolution) {
    lines.push(
      `evolutionProposalCount=${report.evolution.proposalCount}`,
      `evolutionApprovalQueueCount=${report.evolution.approvalQueueCount}`,
      `evolutionOutcomeReviewCount=${report.evolution.outcomeReviewCount}`,
      `evolutionLatestEvidenceWindow=${report.evolution.latestEvidenceWindow}`
    );
  }

  if (report.professionalV2) {
    const professional = report.professionalV2;
    lines.push(
      `runId=${professional.runId}`,
      `configSnapshotId=${professional.configSnapshotId}`,
      `runtimeMode=${professional.runtimeMode}`,
      `ledgerReconciliationStatus=${professional.ledgerReconciliationStatus}`,
      `riskMode=${professional.riskMode}`,
      `dailyPnlMode=${professional.dailyPnlMode}`,
      `dailyPnlSol=${professional.dailyPnlSol ?? 'unknown'}`,
      `drawdownPct=${professional.drawdownPct ?? 'unknown'}`,
      `outboxPending=${professional.outboxPending}`,
      `sourceQuality=${professional.sourceQuality}`,
      `datasetVersion=${professional.datasetVersion}`,
      `researchDataStatus=${professional.researchDataStatus}`
    );
    for (const modePnl of professional.modePnl.modes) {
      lines.push(
        `pnl.${modePnl.mode}.grossPnlSol=${modePnl.grossPnlSol ?? 'unknown'}`,
        `pnl.${modePnl.mode}.netPnlSol=${modePnl.netPnlSol ?? 'unknown'}`,
        `pnl.${modePnl.mode}.realizedPnlSol=${modePnl.realizedPnlSol ?? 'unknown'}`,
        `pnl.${modePnl.mode}.unrealizedPnlSol=${modePnl.unrealizedPnlSol ?? 'unknown'}`,
        `pnl.${modePnl.mode}.finalizedEpisodeCount=${modePnl.finalizedEpisodeCount}`,
        `pnl.${modePnl.mode}.evidenceStatus=${modePnl.evidenceStatus}`
      );
    }
  }

  return lines.join('\n');
}
