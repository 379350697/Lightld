import { describe, expect, it } from 'vitest';

import { recoverPendingSubmission } from '../../../src/runtime/pending-submission-recovery';

describe('recoverPendingSubmission', () => {
  it('resolves and clears a pending submission after finalized confirmation', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k1',
        submissionId: 'sub-1',
        confirmationSignature: 'tx-1',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      confirmationProvider: {
        poll: async () => ({
          submissionId: 'sub-1',
          confirmationSignature: 'tx-1',
          status: 'confirmed',
          finality: 'finalized',
          checkedAt: '2026-03-22T00:01:00.000Z'
        })
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-confirmed'
    });
  });

  it('treats matching account fills as a resolved submission', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k1',
        submissionId: 'sub-1',
        confirmationSignature: 'tx-1',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 2 }],
        journalTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 2 }],
        fills: [
          {
            submissionId: 'sub-1',
            confirmationSignature: 'tx-1',
            mint: 'mint-safe',
            symbol: 'SAFE',
            side: 'buy',
            amount: 2,
            recordedAt: '2026-03-22T00:00:30.000Z'
          }
        ]
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    });
  });

  it('keeps the runtime blocked when an unresolved submission times out', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k1',
        submissionId: 'sub-1',
        confirmationSignature: 'tx-1',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:00:30.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      confirmationProvider: {
        poll: async () => ({
          submissionId: 'sub-1',
          confirmationSignature: 'tx-1',
          status: 'submitted',
          finality: 'processed',
          checkedAt: '2026-03-22T00:01:00.000Z'
        })
      }
    });

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-timeout'
    });
  });
});
