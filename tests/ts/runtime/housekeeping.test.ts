import { describe, expect, it, vi } from 'vitest';

import { createHousekeepingRunner } from '../../../src/runtime/housekeeping';

describe('createHousekeepingRunner', () => {
  it('runs cleanup work on interval and summarizes what was deleted', async () => {
    const runner = createHousekeepingRunner({
      intervalMs: 60_000,
      runJournalCleanup: vi.fn().mockResolvedValue(2),
      runMirrorPrune: vi.fn().mockResolvedValue(5),
      runGmgnCacheSweep: vi.fn().mockReturnValue({
        expiredDeleted: 1,
        evictedDeleted: 1,
        remainingEntries: 7
      })
    });

    const first = await runner.runIfDue(new Date('2026-04-14T00:00:00.000Z'));
    const second = await runner.runIfDue(new Date('2026-04-14T00:00:30.000Z'));
    const third = await runner.runIfDue(new Date('2026-04-14T00:02:00.000Z'));

    expect(first.lastHousekeepingAt).toBe('2026-04-14T00:00:00.000Z');
    expect(first.journalCleanupDeletedFiles).toBe(2);
    expect(first.mirrorPruneDeletedRows).toBe(5);
    expect(first.gmgnSafetyCacheEntries).toBe(7);
    expect(second).toEqual(first);
    expect(third.lastHousekeepingAt).toBe('2026-04-14T00:02:00.000Z');
  });

  it('captures cleanup failures without throwing through the caller', async () => {
    const runner = createHousekeepingRunner({
      intervalMs: 60_000,
      runJournalCleanup: vi.fn().mockRejectedValue(new Error('disk-busy')),
      runGmgnCacheSweep: vi.fn().mockReturnValue({
        expiredDeleted: 0,
        evictedDeleted: 0,
        remainingEntries: 0
      })
    });

    await expect(runner.runIfDue(new Date('2026-04-14T00:00:00.000Z'))).resolves.toMatchObject({
      lastHousekeepingAt: '2026-04-14T00:00:00.000Z',
      lastCleanupError: 'disk-busy'
    });
  });
});
