import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { LiveIncidentJournal } from '../../../src/journals/live-incident-journal';

describe('LiveIncidentJournal', () => {
  it('writes live incident entries', async () => {
    const path = 'tmp/journals/test-live-incidents.jsonl';
    await rm(path, { force: true });

    const journal = new LiveIncidentJournal(path);
    await journal.append({
      reason: 'token-not-whitelisted'
    });

    await expect(journal.readAll()).resolves.toEqual([
      {
        reason: 'token-not-whitelisted'
      }
    ]);
  });
});
