import { describe, expect, it } from 'vitest';

import {
  buildModeSeparatedPnlSnapshotV2,
  buildProfessionalRuntimeStatusV2
} from '../../../src/runtime/professional-runtime-status-v2';

describe('professional runtime status V2', () => {
  it('keeps PnL in explicit per-mode buckets and exposes the active mode value only', () => {
    const modePnl = buildModeSeparatedPnlSnapshotV2([
      {
        mode: 'mechanical-soak',
        grossPnlSol: 99,
        netPnlSol: 98,
        realizedPnlSol: 98,
        unrealizedPnlSol: 0,
        finalizedEpisodeCount: 500,
        evidenceStatus: 'synthetic'
      },
      {
        mode: 'canary',
        grossPnlSol: 0.002,
        netPnlSol: 0.001,
        realizedPnlSol: 0.001,
        unrealizedPnlSol: 0,
        finalizedEpisodeCount: 2,
        evidenceStatus: 'exact'
      }
    ], '2026-07-10T04:02:00.000Z');

    const status = buildProfessionalRuntimeStatusV2({
      runId: 'run-canary',
      configSnapshotId: 'config-canary',
      runtimeMode: 'canary',
      ledgerReconciliationStatus: 'matched',
      riskMode: 'healthy',
      drawdownPct: 0.1,
      outboxPending: 0,
      sourceQuality: 'healthy',
      datasetVersion: 'research-v2/dataset-1',
      researchDataStatus: 'valid',
      modePnl,
      updatedAt: '2026-07-10T04:02:00.000Z'
    });

    expect(status.dailyPnlMode).toBe('canary');
    expect(status.dailyPnlSol).toBe(0.001);
    expect(status.modePnl.modes).toHaveLength(2);
    expect(status).not.toHaveProperty('combinedPnlSol');
    expect(status).not.toHaveProperty('totalPnlSol');
  });

  it('uses unknown instead of borrowing PnL from another mode', () => {
    const status = buildProfessionalRuntimeStatusV2({
      runId: 'run-live',
      configSnapshotId: 'config-live',
      runtimeMode: 'live',
      ledgerReconciliationStatus: 'pending',
      riskMode: 'reconcile_required',
      drawdownPct: 0,
      outboxPending: 1,
      sourceQuality: 'partial',
      datasetVersion: 'research-v2/dataset-1',
      researchDataStatus: 'observing',
      modePnl: buildModeSeparatedPnlSnapshotV2([{
        mode: 'economic-shadow',
        grossPnlSol: 4,
        netPnlSol: 3,
        realizedPnlSol: 3,
        unrealizedPnlSol: 0,
        finalizedEpisodeCount: 100,
        evidenceStatus: 'simulated'
      }]),
      updatedAt: '2026-07-10T04:02:00.000Z'
    });

    expect(status.dailyPnlMode).toBe('live');
    expect(status.dailyPnlSol).toBeNull();
  });
});
