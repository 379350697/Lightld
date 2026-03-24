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
});
