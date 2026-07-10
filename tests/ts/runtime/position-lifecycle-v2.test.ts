import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PositionLifecycleV2Store,
  assertLifecycleIdentity
} from '../../../src/runtime/position-lifecycle-v2';

const STATE_DIR = 'tmp/tests/position-lifecycle-v2';

afterEach(async () => {
  await rm(STATE_DIR, { recursive: true, force: true });
});

describe('PositionLifecycleV2Store', () => {
  it('keeps the entry config snapshot immutable through finalization', async () => {
    const store = new PositionLifecycleV2Store(STATE_DIR);
    const opened = await store.createOpen({
      runId: 'run-1',
      strategyId: 'new-token-v1',
      openIntentId: 'open-1',
      poolAddress: 'pool-1',
      tokenMint: 'mint-1',
      configSnapshotId: 'config-20-30',
      parameterSnapshot: { lpStopLossNetPnlPct: 20, lpTakeProfitNetPnlPct: 30 },
      openedAt: '2026-07-10T00:00:00.000Z'
    });

    const bound = await store.bindChainPosition(opened.lifecycleKey, {
      chainPositionAddress: 'chain-position-1',
      openSignature: 'open-signature-1',
      openSlot: 100,
      confirmedAt: '2026-07-10T00:00:05.000Z'
    });
    const closed = await store.finalizeClose(opened.lifecycleKey, {
      closeSignature: 'close-signature-1',
      closeSlot: 200,
      closedAt: '2026-07-10T01:00:00.000Z',
      finalizedAt: '2026-07-10T01:00:05.000Z',
      exitReasons: ['lp-stop-loss', 'lp-range-exit:above:9']
    });

    expect(bound.status).toBe('open_confirmed');
    expect(closed.status).toBe('finalized_closed');
    expect(closed.primaryReason).toBe('lp-stop-loss');
    expect(closed.exitReasons).toEqual(['lp-stop-loss', 'lp-range-exit:above:9']);
    expect(closed.configSnapshotId).toBe('config-20-30');
    expect(closed.parameterSnapshot).toEqual({
      lpStopLossNetPnlPct: 20,
      lpTakeProfitNetPnlPct: 30
    });
  });

  it('rejects reuse of an open intent or chain position for another target', async () => {
    const store = new PositionLifecycleV2Store(STATE_DIR);
    const first = await store.createOpen({
      runId: 'run-1',
      strategyId: 'new-token-v1',
      openIntentId: 'open-shared',
      poolAddress: 'pool-1',
      tokenMint: 'mint-1',
      configSnapshotId: 'config-1',
      parameterSnapshot: {},
      openedAt: '2026-07-10T00:00:00.000Z'
    });

    await expect(store.createOpen({
      runId: 'run-1',
      strategyId: 'new-token-v1',
      openIntentId: 'open-shared',
      poolAddress: 'pool-2',
      tokenMint: 'mint-2',
      configSnapshotId: 'config-1',
      parameterSnapshot: {},
      openedAt: '2026-07-10T00:00:01.000Z'
    })).rejects.toThrow(/openIntentId identity conflict/);

    await store.bindChainPosition(first.lifecycleKey, {
      chainPositionAddress: 'chain-shared',
      openSignature: 'sig-1',
      openSlot: 100,
      confirmedAt: '2026-07-10T00:00:05.000Z'
    });
    const second = await store.createOpen({
      runId: 'run-1',
      strategyId: 'new-token-v1',
      openIntentId: 'open-2',
      poolAddress: 'pool-2',
      tokenMint: 'mint-2',
      configSnapshotId: 'config-1',
      parameterSnapshot: {},
      openedAt: '2026-07-10T00:01:00.000Z'
    });

    await expect(store.bindChainPosition(second.lifecycleKey, {
      chainPositionAddress: 'chain-shared',
      openSignature: 'sig-2',
      openSlot: 101,
      confirmedAt: '2026-07-10T00:01:05.000Z'
    })).rejects.toThrow(/chainPositionAddress identity conflict/);
  });

  it('rejects mixed target identity before an outcome can be written', () => {
    expect(() => assertLifecycleIdentity({
      lifecycleKey: 'lifecycle-1',
      poolAddress: 'pool-bound',
      tokenMint: 'mint-bound',
      chainPositionAddress: 'chain-bound'
    }, {
      poolAddress: 'pool-other',
      tokenMint: 'mint-bound',
      chainPositionAddress: 'chain-bound'
    })).toThrow(/lifecycle identity conflict/);
  });
});
