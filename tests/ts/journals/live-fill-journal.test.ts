import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LiveFillJournal } from '../../../src/journals/live-fill-journal';

describe('LiveFillJournal', () => {
  it('writes live fill entries', async () => {
    const path = 'tmp/journals/test-live-fills.jsonl';
    await rm(path, { force: true });

    const journal = new LiveFillJournal(path);
    await journal.append({
      submissionId: 's1',
      filledSol: 0.1
    });

    await expect(journal.readAll()).resolves.toEqual([
      {
        submissionId: 's1',
        filledSol: 0.1
      }
    ]);
  });

  it('reads retained rotated fill files across days', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-fills-'));
    const path = join(root, 'test-rotated-live-fills.jsonl');
    let now = new Date('2026-04-17T08:00:00.000Z');

    await rm(root, { recursive: true, force: true });

    const journal = new LiveFillJournal(path, {
      rotateDaily: true,
      retentionDays: 90,
      now: () => now
    });

    await journal.append({
      submissionId: 'old-fill',
      mint: 'mint-old',
      amount: 1,
      recordedAt: '2026-04-17T08:00:00.000Z'
    });

    now = new Date('2026-04-18T08:00:00.000Z');

    await journal.append({
      submissionId: 'new-fill',
      mint: 'mint-new',
      amount: 2,
      recordedAt: '2026-04-18T08:00:00.000Z'
    });

    await expect(journal.readAll()).resolves.toEqual([
      {
        submissionId: 'old-fill',
        mint: 'mint-old',
        amount: 1,
        recordedAt: '2026-04-17T08:00:00.000Z'
      },
      {
        submissionId: 'new-fill',
        mint: 'mint-new',
        amount: 2,
        recordedAt: '2026-04-18T08:00:00.000Z'
      }
    ]);
  });
});
