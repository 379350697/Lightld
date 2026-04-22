import { describe, expect, it } from 'vitest';

import { limitDecisionLogEntries } from '../../../src/dashboard/decision-log-limit.ts';

describe('limitDecisionLogEntries', () => {
  it('returns only the latest 10 decision log entries in reverse chronological order', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      recordedAt: `2026-04-22T00:00:${String(index).padStart(2, '0')}.000Z`,
      reason: `reason-${index}`
    }));

    const result = limitDecisionLogEntries(entries);

    expect(result).toHaveLength(10);
    expect(result.map((entry) => entry.reason)).toEqual([
      'reason-11',
      'reason-10',
      'reason-9',
      'reason-8',
      'reason-7',
      'reason-6',
      'reason-5',
      'reason-4',
      'reason-3',
      'reason-2'
    ]);
  });
});
