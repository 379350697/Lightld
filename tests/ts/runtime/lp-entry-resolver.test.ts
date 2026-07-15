import { describe, expect, it } from 'vitest';

import {
  matchesPositionStateLifecycle,
  resolveTrustedEntryFromFills
} from '../../../src/runtime/lp-entry-resolver';

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

  it('prefers a unique trusted pool-mint fill over stale persisted entry metadata', () => {
    expect(resolveTrustedEntryFromFills({
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'hold',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-safe',
        positionId: 'stale-position',
        lifecycleState: 'open',
        entrySol: 0.137416044,
        entrySolSource: 'actual_fill',
        openedAt: '2026-06-25T02:32:09.860Z',
        updatedAt: '2026-06-25T02:32:09.860Z'
      },
      fills: [{
        submissionId: 'sig-real-open',
        mint: 'mint-safe',
        side: 'add-lp',
        amount: 0.077416045,
        fillAmountSource: 'wallet-delta',
        hasFillEvidence: true,
        positionId: 'pool-safe:mint-safe',
        recordedAt: '2026-06-25T02:25:44.622Z'
      }]
    })).toEqual({
      entrySol: 0.077416045,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'sig-real-open',
      openedAt: '2026-06-25T02:25:44.622Z'
    });
  });

  it('does not treat matching pool and mint as lifecycle bound when chain position differs', () => {
    expect(matchesPositionStateLifecycle({
      poolAddress: 'pool-safe',
      positionAddress: 'current-chain-position',
      mint: 'mint-safe'
    }, {
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      activeMint: 'mint-safe',
      activePoolAddress: 'pool-safe',
      chainPositionAddress: 'stale-chain-position',
      lifecycleState: 'open',
      updatedAt: '2026-06-25T02:32:09.860Z'
    })).toBe(false);
  });
});
