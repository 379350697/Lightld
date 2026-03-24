import { rm } from 'node:fs/promises';

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
});
