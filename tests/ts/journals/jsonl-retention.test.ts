import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LiveOrderJournal } from '../../../src/journals/live-order-journal';
import {
  cleanupRotatedJsonlFiles,
  resolveActiveJsonlPath
} from '../../../src/journals/jsonl-writer';

const ROOT = 'tmp/tests/journals-retention';

describe('JSONL retention', () => {
  it('resolves the active file path with a UTC date suffix', () => {
    expect(
      resolveActiveJsonlPath('tmp/journals/new-token-v1-live-orders.jsonl', new Date('2026-04-14T10:20:30.000Z'))
    ).toBe(join('tmp', 'journals', 'new-token-v1-live-orders-2026-04-14.jsonl'));
  });

  it('deletes rotated files older than the configured retention window', async () => {
    const basePath = join(ROOT, 'cleanup', 'new-token-v1-live-orders.jsonl');
    await rm(dirname(basePath), { recursive: true, force: true });
    await mkdir(dirname(basePath), { recursive: true });

    await writeFile(resolveActiveJsonlPath(basePath, new Date('2026-04-10T00:00:00.000Z')), '{}\n', 'utf8');
    await writeFile(resolveActiveJsonlPath(basePath, new Date('2026-04-12T00:00:00.000Z')), '{}\n', 'utf8');
    await writeFile(resolveActiveJsonlPath(basePath, new Date('2026-04-14T00:00:00.000Z')), '{}\n', 'utf8');

    const deleted = await cleanupRotatedJsonlFiles(basePath, {
      retentionDays: 2,
      now: new Date('2026-04-14T12:00:00.000Z')
    });

    const names = (await readdir(dirname(basePath))).sort();

    expect(deleted).toBe(1);
    expect(names).toEqual([
      'new-token-v1-live-orders-2026-04-12.jsonl',
      'new-token-v1-live-orders-2026-04-14.jsonl'
    ]);
  });

  it('writes through the journal wrapper into the active rotated file', async () => {
    const basePath = join(ROOT, 'wrapper', 'new-token-v1-live-orders.jsonl');
    await rm(dirname(basePath), { recursive: true, force: true });

    const journal = new LiveOrderJournal(basePath, {
      rotateDaily: true,
      now: () => new Date('2026-04-14T02:03:04.000Z')
    });

    await journal.append({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k1'
    });

    const activePath = resolveActiveJsonlPath(basePath, new Date('2026-04-14T02:03:04.000Z'));
    const raw = await readFile(activePath, 'utf8');

    expect(raw.trim()).toContain('"idempotencyKey":"k1"');
  });
});
