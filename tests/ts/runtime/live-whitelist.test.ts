import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LiveWhitelist } from '../../../src/runtime/live-whitelist';

describe('LiveWhitelist', () => {
  it('loads tokens from disk', async () => {
    const whitelist = new LiveWhitelist('data/fixtures/runtime/live-whitelist.json');

    await expect(whitelist.read()).resolves.toEqual(['SAFE', 'CANARY']);
  });

  it('returns an empty list when the file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-live-whitelist-'));
    const whitelist = new LiveWhitelist(join(directory, 'missing.json'));

    await expect(whitelist.read()).resolves.toEqual([]);
  });

  it('deduplicates persisted tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-live-whitelist-'));
    const path = join(directory, 'live-whitelist.json');

    await writeFile(path, JSON.stringify({ tokens: ['SAFE', 'SAFE', 'CANARY'] }, null, 2), 'utf8');

    const whitelist = new LiveWhitelist(path);

    await expect(whitelist.read()).resolves.toEqual(['SAFE', 'CANARY']);
  });
});
