import { describe, expect, it } from 'vitest';

import {
  reconcileIndependentLiveStateV2,
  reconcileLiveState
} from '../../../src/runtime/reconcile-live-state';

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

describe('reconcileIndependentLiveStateV2', () => {
  const source = <TSourceKind extends 'chain-observation' | 'ledger-event-replay' | 'runtime-projection'>(
    sourceId: string,
    sourceKind: TSourceKind,
    overrides: Record<string, unknown> = {}
  ) => ({
    sourceId,
    sourceKind,
    quality: 'healthy' as const,
    finality: 'finalized' as const,
    observedAt: '2026-07-10T00:00:00.000Z',
    solLamports: '1000000000',
    tokenBalances: [{ asset: 'mint-safe', amountRaw: '2000000' }],
    lpPositions: [{
      positionAddress: 'position-safe',
      poolAddress: 'pool-safe',
      mint: 'mint-safe'
    }],
    ...overrides
  });

  it('matches only three healthy, independent sources', () => {
    expect(reconcileIndependentLiveStateV2({
      chain: source('chain-rpc-finalized', 'chain-observation'),
      ledger: source('ledger-event-replay', 'ledger-event-replay'),
      runtime: source('runtime-projection', 'runtime-projection')
    })).toMatchObject({
      ok: true,
      allowNewOpens: true,
      status: 'matched',
      reason: 'matched'
    });
  });

  it('rejects copied values presented as independent reconciliation', () => {
    expect(reconcileIndependentLiveStateV2({
      chain: source('account-state-handler', 'chain-observation'),
      ledger: source('account-state-handler', 'ledger-event-replay'),
      runtime: source('runtime-projection', 'runtime-projection')
    })).toMatchObject({
      ok: false,
      allowNewOpens: false,
      status: 'degraded',
      reason: 'source-not-independent'
    });
  });

  it('fails closed on partial source data even when the available values match', () => {
    expect(reconcileIndependentLiveStateV2({
      chain: source('chain-rpc-finalized', 'chain-observation', { quality: 'partial' }),
      ledger: source('ledger-event-replay', 'ledger-event-replay'),
      runtime: source('runtime-projection', 'runtime-projection')
    })).toMatchObject({
      ok: false,
      allowNewOpens: false,
      status: 'partial',
      reason: 'source-partial'
    });
  });

  it('reports exact asset and LP differences instead of masking them as healthy', () => {
    const result = reconcileIndependentLiveStateV2({
      chain: source('chain-rpc-finalized', 'chain-observation'),
      ledger: source('ledger-event-replay', 'ledger-event-replay', {
        solLamports: '999999999',
        tokenBalances: [{ asset: 'mint-safe', amountRaw: '1999990' }],
        lpPositions: []
      }),
      runtime: source('runtime-projection', 'runtime-projection', {
        solLamports: '999999999',
        tokenBalances: [{ asset: 'mint-safe', amountRaw: '1999990' }],
        lpPositions: []
      })
    });

    expect(result).toMatchObject({
      ok: false,
      allowNewOpens: false,
      status: 'mismatch',
      reason: 'balance-mismatch',
      chainVsLedger: {
        solDeltaLamports: '1',
        assetDeltas: [{ asset: 'mint-safe', deltaRaw: '10' }],
        lpPositionDeltas: [{ positionAddress: 'position-safe', leftPresent: true, rightPresent: false }]
      }
    });
  });
});
