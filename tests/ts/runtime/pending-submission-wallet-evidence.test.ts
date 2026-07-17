import { describe, expect, it } from 'vitest';

import { matchesPendingLpEvidence } from '../../../src/runtime/pending-submission-wallet-evidence';

describe('pending submission LP wallet evidence', () => {
  it('requires pool and mint to match together when both identities are known', () => {
    const pending = {
      tokenMint: 'mint-a',
      poolAddress: 'pool-a',
      chainPositionAddress: undefined
    };

    expect(matchesPendingLpEvidence(pending as any, {
      mint: 'mint-a',
      poolAddress: 'pool-other'
    })).toBe(false);
    expect(matchesPendingLpEvidence(pending as any, {
      mint: 'mint-other',
      poolAddress: 'pool-a'
    })).toBe(false);
    expect(matchesPendingLpEvidence(pending as any, {
      mint: 'mint-a',
      poolAddress: 'pool-a'
    })).toBe(true);
  });

  it('uses the exact chain position address ahead of pool or mint fallbacks', () => {
    const pending = {
      tokenMint: 'mint-a',
      poolAddress: 'pool-a',
      chainPositionAddress: 'position-a'
    };

    expect(matchesPendingLpEvidence(pending as any, {
      mint: 'mint-a',
      poolAddress: 'pool-a',
      positionAddress: 'position-other'
    })).toBe(false);
    expect(matchesPendingLpEvidence(pending as any, {
      mint: 'mint-other',
      poolAddress: 'pool-other',
      chainPositionAddress: 'position-a'
    })).toBe(true);
  });
});
