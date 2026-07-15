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
      research: {
        activeExperiment: { experimentId: 'personal-test' },
        snapshotCount: 3,
        episodeCount: 8,
        selectedEpisodeCount: 4,
        paperOutcomeCount: 2,
        marks: { '15': 8, '60': 7, '240': 6, '1440': 5 },
        worker: {
          status: 'ok',
          heartbeatAt: '2026-03-22T00:00:04.000Z'
        }
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
    expect(output).toContain('researchExperiment=personal-test');
    expect(output).toContain('researchSnapshotCount=3');
    expect(output).toContain('researchEpisodeCount=8');
    expect(output).toContain('researchSelectedEpisodeCount=4');
    expect(output).toContain('researchPaperOutcomeCount=2');
    expect(output).toContain('researchMark24h=5');
    expect(output).toContain('researchWorkerStatus=ok');
  });
});
