import { describe, expect, it } from 'vitest';

import { resolveTrustedEntryFromFills } from '../../../src/runtime/lp-entry-resolver';

describe('lp entry resolver', () => {
  it('recovers a trusted entry from a unique pool-mint fill when chain position binding is not yet available', () => {
    expect(resolveTrustedEntryFromFills({
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'hold',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-safe',
        positionId: 'chain-position-safe',
        chainPositionAddress: 'chain-position-safe',
        lifecycleState: 'open',
        updatedAt: '2026-06-24T15:47:38.975Z'
      },
      fills: [{
        submissionId: 'sig-open',
        mint: 'mint-safe',
        side: 'add-lp',
        amount: 0.139490124,
        fillAmountSource: 'wallet-delta',
        hasFillEvidence: true,
        positionId: 'pool-safe:mint-safe',
        recordedAt: '2026-06-24T15:42:24.265Z'
      }]
    })).toEqual({
      entrySol: 0.139490124,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'sig-open',
      openedAt: '2026-06-24T15:42:24.265Z'
    });
  });

  it('does not guess an entry from competing pool-mint fills', () => {
    expect(resolveTrustedEntryFromFills({
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'hold',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-safe',
        lifecycleState: 'open',
        updatedAt: '2026-06-24T15:47:38.975Z'
      },
      fills: [
        {
          submissionId: 'sig-open-1',
          mint: 'mint-safe',
          side: 'add-lp',
          amount: 0.1,
          fillAmountSource: 'wallet-delta',
          hasFillEvidence: true,
          positionId: 'pool-safe:mint-safe',
          recordedAt: '2026-06-24T15:40:00.000Z'
        },
        {
          submissionId: 'sig-open-2',
          mint: 'mint-safe',
          side: 'add-lp',
          amount: 0.2,
          fillAmountSource: 'wallet-delta',
          hasFillEvidence: true,
          positionId: 'pool-safe:mint-safe',
          recordedAt: '2026-06-24T15:42:00.000Z'
        }
      ]
    })).toBeUndefined();
  });
});
