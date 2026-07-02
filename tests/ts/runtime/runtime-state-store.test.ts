import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RuntimeStateStore } from '../../../src/runtime/runtime-state-store';

describe('RuntimeStateStore', () => {
  it('persists and reloads runtime state snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-runtime-state-'));
    const store = new RuntimeStateStore(directory);

    await store.writeRuntimeState({
      mode: 'healthy',
      circuitReason: '',
      cooldownUntil: '',
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:01.000Z'
    });

    await expect(store.readRuntimeState()).resolves.toEqual({
      mode: 'healthy',
      circuitReason: '',
      cooldownUntil: '',
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:01.000Z'
    });
  });

  it('returns null when the snapshot is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-runtime-state-'));
    const store = new RuntimeStateStore(directory);

    await expect(store.readRuntimeState()).resolves.toBeNull();
  });

  it('persists and reloads canonical LP identity and valuation fields in position state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-runtime-position-state-'));
    const store = new RuntimeStateStore(directory);

    await store.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'live-order-submitted',
      activeMint: 'mint-safe',
      activePoolAddress: 'pool-1',
      lifecycleState: 'open',
      openIntentId: 'intent-1',
      positionId: 'position-1',
      chainPositionAddress: 'chain-pos-1',
      entrySol: 0.15,
      openedAt: '2026-04-19T00:00:00.000Z',
      valuationStatus: 'ready',
      valuationReason: '',
      lastValuationAt: '2026-04-19T00:01:00.000Z',
      lastClosedMint: '',
      lastClosedAt: '',
      updatedAt: '2026-04-19T00:01:00.000Z'
    } as any);

    await expect(store.readPositionState()).resolves.toMatchObject({
      openIntentId: 'intent-1',
      positionId: 'position-1',
      chainPositionAddress: 'chain-pos-1',
      valuationStatus: 'ready',
      lastValuationAt: '2026-04-19T00:01:00.000Z'
    });
  });

  it('persists and reloads multiple LP position ledger records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-runtime-position-ledger-'));
    const store = new RuntimeStateStore(directory);

    await store.writePositionLedger({
      version: 1,
      updatedAt: '2026-06-29T00:00:00.000Z',
      records: [
        {
          positionKey: 'chain-position:pos-a',
          positionId: 'pos-a',
          chainPositionAddress: 'pos-a',
          activeMint: 'mint-a',
          activePoolAddress: 'pool-a',
          lifecycleState: 'open',
          entrySol: 0.1,
          entrySolSource: 'actual_fill',
          openedAt: '2026-06-29T00:00:00.000Z',
          lastAction: 'add-lp',
          updatedAt: '2026-06-29T00:00:00.000Z'
        },
        {
          positionKey: 'chain-position:pos-b',
          positionId: 'pos-b',
          chainPositionAddress: 'pos-b',
          activeMint: 'mint-b',
          activePoolAddress: 'pool-b',
          lifecycleState: 'open',
          importStatus: 'entry_unknown',
          lastAction: 'hold',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }
      ]
    });

    await expect(store.readPositionLedger()).resolves.toMatchObject({
      version: 1,
      records: [
        {
          chainPositionAddress: 'pos-a',
          activeMint: 'mint-a',
          lifecycleState: 'open'
        },
        {
          chainPositionAddress: 'pos-b',
          activeMint: 'mint-b',
          importStatus: 'entry_unknown'
        }
      ]
    });
  });

  it('appends and reloads lifecycle events in order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-runtime-lifecycle-events-'));
    const store = new RuntimeStateStore(directory);

    await store.appendLifecycleEvents([
      {
        eventKey: 'event-1',
        eventType: 'OpenIntentCreated',
        strategyId: 'new-token-v1',
        openIntentId: 'open-1',
        poolAddress: 'pool-1',
        tokenMint: 'mint-1',
        createdAt: '2026-07-02T00:00:00.000Z'
      },
      {
        eventKey: 'event-2',
        eventType: 'BroadcastSubmitted',
        strategyId: 'new-token-v1',
        openIntentId: 'open-1',
        idempotencyKey: 'order-1',
        submissionId: 'sig-1',
        action: 'add-lp',
        poolAddress: 'pool-1',
        tokenMint: 'mint-1',
        createdAt: '2026-07-02T00:00:01.000Z'
      }
    ]);

    await store.appendLifecycleEvents([{
      eventKey: 'event-2',
      eventType: 'BroadcastSubmitted',
      strategyId: 'new-token-v1',
      openIntentId: 'open-1',
      idempotencyKey: 'order-1',
      submissionId: 'sig-1',
      action: 'add-lp',
      poolAddress: 'pool-1',
      tokenMint: 'mint-1',
      createdAt: '2026-07-02T00:00:01.000Z'
    }]);

    await expect(store.readLifecycleEventLog()).resolves.toEqual({
      version: 1,
      updatedAt: '2026-07-02T00:00:01.000Z',
      events: [
        expect.objectContaining({ eventKey: 'event-1', eventType: 'OpenIntentCreated' }),
        expect.objectContaining({ eventKey: 'event-2', eventType: 'BroadcastSubmitted' })
      ]
    });
  });
});
