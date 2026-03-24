import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { LiveOrderJournal } from '../../../src/journals/live-order-journal';

describe('LiveOrderJournal', () => {
  it('writes live order entries', async () => {
    const path = 'tmp/journals/test-live-orders.jsonl';
    await rm(path, { force: true });

    const journal = new LiveOrderJournal(path);
    await journal.append({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k1'
    });

    await expect(journal.readAll()).resolves.toEqual([
      {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k1'
      }
    ]);
  });
});
