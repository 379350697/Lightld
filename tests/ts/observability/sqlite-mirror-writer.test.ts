import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteMirrorWriter } from '../../../src/observability/sqlite-mirror-writer';

describe('SqliteMirrorWriter', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('initializes schema and writes a batch of mirror events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-'));
    directories.push(root);
    const writer = new SqliteMirrorWriter({ path: join(root, 'mirror.sqlite') });

    await writer.open();
    await writer.writeBatch([
      {
        type: 'runtime_snapshot',
        priority: 'high',
        payload: {
          snapshotAt: '2026-03-22T00:00:00.000Z',
          runtimeMode: 'healthy',
          allowNewOpens: true,
          flattenOnly: false,
          pendingSubmission: false,
          circuitReason: '',
          quoteFailures: 0,
          reconcileFailures: 0
        }
      }
    ]);

    await expect(writer.countRows('runtime_snapshots')).resolves.toBe(1);
    await writer.close();
  });
});
