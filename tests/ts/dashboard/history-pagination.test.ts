import { describe, expect, it } from 'vitest';

import { paginateHistoryEntries } from '../../../src/dashboard/history-pagination';

describe('paginateHistoryEntries', () => {
  it('returns 10 historical rows per page with navigation metadata', () => {
    const entries = Array.from({ length: 23 }, (_, index) => ({
      tokenMint: `mint-${index}`,
      tokenSymbol: `SYM${index}`,
      action: 'add-lp -> withdraw-lp',
      amountSol: index + 1,
      recordedAt: `2026-04-22T00:${String(index).padStart(2, '0')}:00.000Z`,
      source: 'matched' as const,
      confirmationStatus: 'ok'
    }));

    const result = paginateHistoryEntries(entries, {
      page: 2,
      pageSize: 10
    });

    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    expect(result.totalEntries).toBe(23);
    expect(result.totalPages).toBe(3);
    expect(result.hasPrevPage).toBe(true);
    expect(result.hasNextPage).toBe(true);
    expect(result.entries).toHaveLength(10);
    expect(result.entries.map((entry) => entry.tokenMint)).toEqual([
      'mint-10',
      'mint-11',
      'mint-12',
      'mint-13',
      'mint-14',
      'mint-15',
      'mint-16',
      'mint-17',
      'mint-18',
      'mint-19'
    ]);
  });

  it('clamps invalid page values to the nearest valid page', () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({
      tokenMint: `mint-${index}`,
      tokenSymbol: `SYM${index}`,
      action: 'add-lp',
      amountSol: index + 1,
      recordedAt: `2026-04-22T00:0${index}:00.000Z`,
      source: 'error' as const,
      confirmationStatus: 'missing-chain'
    }));

    const result = paginateHistoryEntries(entries, {
      page: 99,
      pageSize: 10
    });

    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.hasPrevPage).toBe(false);
    expect(result.hasNextPage).toBe(false);
    expect(result.entries).toHaveLength(3);
  });
});
