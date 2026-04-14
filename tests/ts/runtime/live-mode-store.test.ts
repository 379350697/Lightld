import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LiveModeStore } from '../../../src/runtime/live-mode-store';

describe('LiveModeStore', () => {
  it('persists live mode state to disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-live-mode-store-'));
    const store = new LiveModeStore(join(directory, 'live-mode.json'));

    await store.write({
      globalMode: 'SHADOW',
      liveStrategies: ['new-token-v1'],
      killSwitchEngaged: false
    });

    await expect(store.read()).resolves.toEqual({
      globalMode: 'SHADOW',
      liveStrategies: ['new-token-v1'],
      killSwitchEngaged: false
    });
  });

  it('returns the default state when the file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-live-mode-store-'));
    const store = new LiveModeStore(join(directory, 'missing.json'));

    await expect(store.read()).resolves.toEqual({
      globalMode: 'OFF',
      liveStrategies: [],
      killSwitchEngaged: false
    });
  });
});
