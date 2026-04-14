import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { QuoteJournal } from '../../../src/journals/quote-journal';

describe('QuoteJournal', () => {
  it('writes quote entries', async () => {
    const path = 'tmp/journals/test-quotes.jsonl';
    await rm(path, { force: true });

    const journal = new QuoteJournal(path);
    await journal.append({
      outputSol: 0.1,
      routeExists: true
    });

    await expect(journal.readAll()).resolves.toEqual([
      {
        outputSol: 0.1,
        routeExists: true
      }
    ]);
  });
});
