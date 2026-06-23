import { describe, expect, it } from 'vitest';

import { normalizeDashboardJournalFill } from '../../../src/dashboard/fill-normalization';

describe('normalizeDashboardJournalFill', () => {
  it('falls back to filledSol when legacy amount is missing', () => {
    expect(normalizeDashboardJournalFill({
      submissionId: 'sub-1',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      side: 'add-lp',
      filledSol: 0.05,
      recordedAt: '2026-04-20T00:00:00.000Z'
    })).toMatchObject({
      amount: 0.05,
      filledSol: 0.05
    });
  });

  it('keeps explicit amount when it is already present', () => {
    expect(normalizeDashboardJournalFill({
      submissionId: 'sub-2',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      side: 'withdraw-lp',
      amount: 0.052,
      filledSol: 0.052,
      recordedAt: '2026-04-20T00:05:00.000Z'
    })).toMatchObject({
      amount: 0.052,
      filledSol: 0.052
    });
  });

  it('does not trust legacy fills without source or wallet-delta evidence', () => {
    expect(normalizeDashboardJournalFill({
      submissionId: 'sub-legacy',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      side: 'add-lp',
      filledSol: 0.05,
      recordedAt: '2026-04-20T00:00:00.000Z'
    })).toMatchObject({
      filledSol: 0.05,
      hasFillEvidence: false
    });

    expect(normalizeDashboardJournalFill({
      submissionId: 'sub-wallet',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      side: 'add-lp',
      filledSol: 0.05,
      actualWalletDeltaSol: -0.05,
      fillAmountSource: 'wallet-delta',
      recordedAt: '2026-04-20T00:01:00.000Z'
    })).toMatchObject({
      filledSol: 0.05,
      hasFillEvidence: true
    });
  });
});
