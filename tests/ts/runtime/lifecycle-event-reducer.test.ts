import { describe, expect, it } from 'vitest';

import { reduceLifecycleEventsToLedger } from '../../../src/runtime/lifecycle-event-reducer';
import { buildLifecycleProjection } from '../../../src/runtime/lifecycle-projection';
import type { LifecycleEventRecord } from '../../../src/runtime/state-types';

const now = '2026-07-02T00:00:00.000Z';

describe('lifecycle event reducer', () => {
  it('keeps not-submitted opens in attempts only and out of position lifecycle', () => {
    const events: LifecycleEventRecord[] = [{
      eventKey: 'event-not-submitted',
      eventType: 'BroadcastNotSubmitted',
      strategyId: 'new-token-v1',
      openIntentId: 'open-1',
      idempotencyKey: 'order-1',
      action: 'add-lp',
      poolAddress: 'pool-1',
      tokenMint: 'mint-1',
      reason: 'tx simulation failed',
      createdAt: now
    }];

    const ledger = reduceLifecycleEventsToLedger({ events, now });

    expect(ledger.records).toHaveLength(0);
    expect(buildLifecycleProjection({ ledger }).activeLpCount).toBe(0);
  });

  it('promotes a submitted open into one chain-backed position when chain evidence arrives', () => {
    const events: LifecycleEventRecord[] = [
      {
        eventKey: 'event-open',
        eventType: 'OpenIntentCreated',
        strategyId: 'new-token-v1',
        openIntentId: 'open-1',
        poolAddress: 'pool-1',
        tokenMint: 'mint-1',
        createdAt: now
      },
      {
        eventKey: 'event-submitted',
        eventType: 'BroadcastSubmitted',
        strategyId: 'new-token-v1',
        openIntentId: 'open-1',
        idempotencyKey: 'order-1',
        submissionId: 'sig-1',
        action: 'add-lp',
        poolAddress: 'pool-1',
        tokenMint: 'mint-1',
        createdAt: '2026-07-02T00:00:01.000Z'
      },
      {
        eventKey: 'event-chain',
        eventType: 'ChainPositionObserved',
        strategyId: 'new-token-v1',
        openIntentId: 'open-1',
        positionId: 'pos-1',
        chainPositionAddress: 'pos-1',
        poolAddress: 'pool-1',
        tokenMint: 'mint-1',
        createdAt: '2026-07-02T00:00:02.000Z'
      }
    ];

    const ledger = reduceLifecycleEventsToLedger({ events, now });

    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({
      positionKey: 'chain-position:pos-1',
      openIntentId: 'open-1',
      chainPositionAddress: 'pos-1',
      activePoolAddress: 'pool-1',
      activeMint: 'mint-1',
      lifecycleState: 'open'
    });
    expect(buildLifecycleProjection({ ledger }).chainActiveLpCount).toBe(1);
  });

  it('keeps residual cleanup as a closed-position obligation instead of active LP state', () => {
    const events: LifecycleEventRecord[] = [
      {
        eventKey: 'event-chain',
        eventType: 'ChainPositionObserved',
        strategyId: 'new-token-v1',
        openIntentId: 'open-1',
        chainPositionAddress: 'pos-1',
        poolAddress: 'pool-1',
        tokenMint: 'mint-1',
        createdAt: now
      },
      {
        eventKey: 'event-closed',
        eventType: 'PositionClosed',
        strategyId: 'new-token-v1',
        openIntentId: 'open-1',
        chainPositionAddress: 'pos-1',
        action: 'withdraw-lp',
        poolAddress: 'pool-1',
        tokenMint: 'mint-1',
        createdAt: '2026-07-02T00:00:01.000Z'
      },
      {
        eventKey: 'event-residual',
        eventType: 'ResidualCleanupRequired',
        strategyId: 'new-token-v1',
        openIntentId: 'open-1',
        chainPositionAddress: 'pos-1',
        poolAddress: 'pool-1',
        tokenMint: 'mint-1',
        residualCleanupStatus: 'residual_cleanup_pending',
        residualCleanupValueSol: 0.012,
        createdAt: '2026-07-02T00:00:02.000Z'
      }
    ];

    const ledger = reduceLifecycleEventsToLedger({ events, now });
    const projection = buildLifecycleProjection({ ledger });

    expect(ledger.records[0]).toMatchObject({
      lifecycleState: 'closed',
      residualCleanupStatus: 'residual_cleanup_pending'
    });
    expect(projection.activeLpCount).toBe(0);
    expect(projection.residualCleanupRequiredCount).toBe(1);
  });
});
