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
});
