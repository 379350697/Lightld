import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';

describe('PendingSubmissionStore', () => {
  it('persists and clears pending submissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lightld-pending-submission-'));
    const store = new PendingSubmissionStore(directory);

    await store.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k1',
      submissionId: 'sub-1',
      confirmationStatus: 'submitted',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z'
    });

    await expect(store.read()).resolves.toMatchObject({
      idempotencyKey: 'k1',
      confirmationStatus: 'submitted'
    });

    await store.clear();
    await expect(store.read()).resolves.toBeNull();
  });
});
