import { describe, expect, it } from 'vitest';

import { reconcileLiveState } from '../../../src/runtime/reconcile-live-state';

describe('reconcileLiveState', () => {
  it('returns matched when wallet and journal balances align', () => {
    expect(
      reconcileLiveState({
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [
          { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
        ],
        journalTokens: [
          { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
        ]
      })
    ).toEqual({
      ok: true,
      deltaSol: 0,
      tokenDeltas: [],
      lpPositionDeltas: [],
      reason: 'matched'
    });
  });

  it('returns a balance mismatch when they diverge', () => {
    expect(
      reconcileLiveState({
        walletSol: 1.5,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: []
      })
    ).toEqual({
      ok: false,
      deltaSol: 0.25,
      tokenDeltas: [],
      lpPositionDeltas: [],
      reason: 'balance-mismatch'
    });
  });

  it('returns a balance mismatch when token holdings diverge', () => {
    expect(
      reconcileLiveState({
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [
          { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
        ],
        journalTokens: [
          { mint: 'mint-safe', symbol: 'SAFE', amount: 1.5 }
        ]
      })
    ).toEqual({
      ok: false,
      deltaSol: 0,
      tokenDeltas: [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          walletAmount: 2,
          journalAmount: 1.5,
          deltaAmount: 0.5
        }
      ],
      lpPositionDeltas: [],
      reason: 'balance-mismatch'
    });
  });

  it('returns a balance mismatch when lp positions diverge', () => {
    expect(
      reconcileLiveState({
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [
          { poolAddress: 'pool-safe', positionAddress: 'pos-1', mint: 'mint-safe' }
        ],
        journalLpPositions: []
      })
    ).toEqual({
      ok: false,
      deltaSol: 0,
      tokenDeltas: [],
      lpPositionDeltas: [
        {
          positionAddress: 'pos-1',
          mint: 'mint-safe',
          walletPresent: true,
          journalPresent: false,
          poolAddress: 'pool-safe'
        }
      ],
      reason: 'balance-mismatch'
    });
  });
});
