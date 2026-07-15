import { describe, expect, it } from 'vitest';

import { HttpLiveAccountStateProvider } from '../../../src/runtime/live-account-provider';

describe('HttpLiveAccountStateProvider', () => {
  it('reads wallet and journal balances from an external http service', async () => {
    const provider = new HttpLiveAccountStateProvider({
      url: 'https://account.example/api',
      fetchImpl: async (_input, init) => {
        expect(init?.method).toBe('GET');

        return new Response(
          JSON.stringify({
            walletSol: 1.25,
            journalSol: 1.25,
            walletLpPositions: [
              { poolAddress: 'pool-1', positionAddress: 'pos-1', mint: 'mint-safe', positionStatus: 'residual' }
            ],
            journalLpPositions: [
              { poolAddress: 'pool-1', positionAddress: 'pos-1', mint: 'mint-safe', positionStatus: 'residual' }
            ],
            walletTokens: [
              { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
            ],
            journalTokens: [
              { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
            ],
            fills: [
              {
                submissionId: 'sub-1',
                confirmationSignature: 'tx-1',
                mint: 'mint-safe',
                symbol: 'SAFE',
                side: 'buy',
                amount: 2,
                recordedAt: '2026-03-22T00:00:00.000Z'
              }
            ]
          }),
          { status: 200 }
        );
      }
    });

    await expect(provider.readState()).resolves.toEqual({
      walletSol: 1.25,
      journalSol: 1.25,
      walletLpPositions: [
        { poolAddress: 'pool-1', positionAddress: 'pos-1', mint: 'mint-safe', positionStatus: 'residual' }
      ],
      journalLpPositions: [
        { poolAddress: 'pool-1', positionAddress: 'pos-1', mint: 'mint-safe', positionStatus: 'residual' }
      ],
      walletTokens: [
        { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
      ],
      journalTokens: [
        { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
      ],
      fills: [
        {
          submissionId: 'sub-1',
          confirmationSignature: 'tx-1',
          mint: 'mint-safe',
          symbol: 'SAFE',
          side: 'buy',
          amount: 2,
          recordedAt: '2026-03-22T00:00:00.000Z'
        }
      ]
    });
  });

  it('uses a longer default timeout for cold account-state reads', () => {
    const provider = new HttpLiveAccountStateProvider({
      url: 'https://account.example/api'
    });

    expect((provider as unknown as { timeoutMs: number }).timeoutMs).toBe(15_000);
    expect((provider as unknown as { maxRetries: number }).maxRetries).toBe(2);
  });
});
