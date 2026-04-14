import { describe, expect, it } from 'vitest';

import { MirrorBuffer } from '../../../src/observability/mirror-buffer';

describe('MirrorBuffer', () => {
  it('drops low priority events before high priority events when full', () => {
    const buffer = new MirrorBuffer({ capacity: 2 });

    buffer.enqueue({
      type: 'cycle_run',
      priority: 'low',
      payload: {
        cycleId: 'c1',
        strategyId: 'new-token-v1',
        startedAt: '2026-03-22T00:00:00.000Z',
        finishedAt: '2026-03-22T00:00:01.000Z',
        runtimeMode: 'healthy',
        sessionPhase: 'active',
        action: 'hold',
        resultMode: 'BLOCKED',
        reason: 'hold',
        poolAddress: '',
        tokenMint: '',
        tokenSymbol: '',
        requestedPositionSol: 0,
        quoteCollected: false,
        liveOrderSubmitted: false,
        confirmationStatus: 'unknown',
        reconciliationOk: true,
        durationMs: 1
      }
    });
    buffer.enqueue({
      type: 'incident',
      priority: 'high',
      payload: {
        incidentId: 'i1',
        cycleId: 'c2',
        stage: 'mirror',
        severity: 'warning',
        reason: 'test',
        runtimeMode: 'healthy',
        submissionId: '',
        tokenMint: '',
        tokenSymbol: '',
        recordedAt: '2026-03-22T00:00:00.000Z'
      }
    });
    buffer.enqueue({
      type: 'order',
      priority: 'high',
      payload: {
        idempotencyKey: 'k1',
        cycleId: 'c3',
        strategyId: 'new-token-v1',
        submissionId: '',
        confirmationSignature: '',
        poolAddress: 'pool-1',
        tokenMint: 'mint-1',
        tokenSymbol: 'SAFE',
        action: 'deploy',
        requestedPositionSol: 0.1,
        quotedOutputSol: 0.1,
        broadcastStatus: 'pending',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      }
    });

    expect(buffer.snapshot().droppedLowPriority).toBe(1);
    expect(buffer.drain(10).map((event) => event.type)).toEqual(['incident', 'order']);
  });
});
