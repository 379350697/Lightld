import { describe, expect, it } from 'vitest';

import { formatRuntimeStatus } from '../../../src/cli/show-runtime-status';

describe('formatRuntimeStatus', () => {
  it('renders a readable runtime status summary', () => {
    const output = formatRuntimeStatus({
      mode: 'degraded',
      allowNewOpens: false,
      activeLpCount: 2,
      chainActiveLpCount: 1,
      pendingOpenCount: 1,
      reconcileRequiredCount: 0,
      flattenOnly: true,
      pendingSubmission: true,
      circuitReason: 'quote-degraded',
      lastSuccessfulTickAt: '2026-03-22T00:00:00.000Z',
      dependencyHealth: {
        quoteFailures: 3,
        reconcileFailures: 0
      },
      housekeeping: {
        lastHousekeepingAt: '2026-03-22T00:00:06.000Z',
        journalCleanupDeletedFiles: 2,
        mirrorPruneDeletedRows: 4,
        gmgnSafetyCacheEntries: 9,
        lastCleanupError: ''
      },
      mirror: {
        enabled: true,
        state: 'degraded',
        path: '/tmp/lightld.sqlite',
        queueDepth: 5,
        queueCapacity: 1000,
        droppedEvents: 1,
        droppedLowPriority: 1,
        consecutiveFailures: 1,
        lastFlushAt: '2026-03-22T00:00:04.000Z',
        lastFlushLatencyMs: 12,
        cooldownUntil: '',
        lastError: ''
      },
      updatedAt: '2026-03-22T00:00:05.000Z'
      ,
      recentCandidateScans: [
        {
          scanId: 'scan-1',
          capturedAt: '2026-03-22T00:00:01.000Z',
          strategyId: 'new-token-v1',
          selectedTokenMint: 'mint-safe',
          selectedPoolAddress: 'pool-safe',
          blockedReason: '',
          candidateCount: 2
        }
      ],
      recentWatchlistSnapshots: [
        {
          watchId: 'watch-1',
          trackedSince: '2026-03-22T00:00:00.000Z',
          strategyId: 'new-token-v1',
          tokenMint: 'mint-safe',
          tokenSymbol: 'SAFE',
          poolAddress: 'pool-safe',
          observationAt: '2026-03-22T01:00:00.000Z',
          windowLabel: '1h',
          currentValueSol: 0.4,
          unclaimedFeeSol: 0.02,
          hasInventory: true,
          hasLpPosition: true,
          sourceReason: 'selected'
        }
      ],
      evolution: {
        proposalCount: 3,
        approvalQueueCount: 2,
        outcomeReviewCount: 1,
        latestEvidenceWindow: 'last-24h'
      },
      professionalV2: {
        schemaVersion: 2,
        runId: 'run-canary',
        configSnapshotId: 'config-canary',
        runtimeMode: 'canary',
        ledgerReconciliationStatus: 'matched',
        riskMode: 'healthy',
        dailyPnlMode: 'canary',
        dailyPnlSol: 0.001,
        drawdownPct: 0.1,
        outboxPending: 0,
        sourceQuality: 'healthy',
        datasetVersion: 'research-v2/dataset-1',
        researchDataStatus: 'valid',
        modePnl: {
          schemaVersion: 2,
          asOf: '2026-07-10T04:02:00.000Z',
          modes: [{
            mode: 'canary',
            grossPnlSol: 0.002,
            netPnlSol: 0.001,
            realizedPnlSol: 0.001,
            unrealizedPnlSol: 0,
            finalizedEpisodeCount: 2,
            evidenceStatus: 'exact'
          }, {
            mode: 'mechanical-soak',
            grossPnlSol: 99,
            netPnlSol: 98,
            realizedPnlSol: 98,
            unrealizedPnlSol: 0,
            finalizedEpisodeCount: 500,
            evidenceStatus: 'synthetic'
          }]
        },
        updatedAt: '2026-07-10T04:02:00.000Z'
      }
    });

    expect(output).toContain('mode=degraded');
    expect(output).toContain('chainActiveLpCount=1');
    expect(output).toContain('pendingOpenCount=1');
    expect(output).toContain('reconcileRequiredCount=0');
    expect(output).toContain('pendingSubmission=true');
    expect(output).toContain('mirrorState=degraded');
    expect(output).toContain('lastHousekeepingAt=2026-03-22T00:00:06.000Z');
    expect(output).toContain('mirrorPruneDeletedRows=4');
    expect(output).toContain('recentCandidateScans=1');
    expect(output).toContain('recentWatchlistSnapshots=1');
    expect(output).toContain('evolutionProposalCount=3');
    expect(output).toContain('evolutionApprovalQueueCount=2');
    expect(output).toContain('evolutionOutcomeReviewCount=1');
    expect(output).toContain('evolutionLatestEvidenceWindow=last-24h');
    expect(output).toContain('runId=run-canary');
    expect(output).toContain('configSnapshotId=config-canary');
    expect(output).toContain('ledgerReconciliationStatus=matched');
    expect(output).toContain('riskMode=healthy');
    expect(output).toContain('dailyPnlMode=canary');
    expect(output).toContain('dailyPnlSol=0.001');
    expect(output).toContain('drawdownPct=0.1');
    expect(output).toContain('outboxPending=0');
    expect(output).toContain('sourceQuality=healthy');
    expect(output).toContain('datasetVersion=research-v2/dataset-1');
    expect(output).toContain('researchDataStatus=valid');
    expect(output).toContain('pnl.canary.netPnlSol=0.001');
    expect(output).toContain('pnl.mechanical-soak.display=disabled');
    expect(output).toContain('pnl.mechanical-soak.evidenceStatus=synthetic');
    expect(output).not.toContain('pnl.mechanical-soak.netPnlSol=');
    expect(output).not.toContain('totalPnlSol=');
  });
});
