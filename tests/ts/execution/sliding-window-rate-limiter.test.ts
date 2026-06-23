import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileBackedSlidingWindowRateLimiter } from '../../../src/execution/solana/sliding-window-rate-limiter';

describe('FileBackedSlidingWindowRateLimiter', () => {
  it('shares the sliding window across limiter instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-rate-limit-'));
    const statePath = join(root, 'jupiter-rate-limit.json');
    let now = 0;
    const sleeps: number[] = [];
    const sleep = async (delayMs: number) => {
      sleeps.push(delayMs);
      now += delayMs;
    };
    const first = new FileBackedSlidingWindowRateLimiter({
      statePath,
      capacity: 1,
      windowMs: 100,
      nowMs: () => now,
      sleep
    });
    const second = new FileBackedSlidingWindowRateLimiter({
      statePath,
      capacity: 1,
      windowMs: 100,
      nowMs: () => now,
      sleep
    });

    await first.waitForSlot();
    await second.waitForSlot();

    expect(sleeps).toEqual([100]);
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { timestamps: number[] };
    expect(persisted.timestamps).toEqual([100]);
  });
});
