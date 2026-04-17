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

  it('resolves a tracked Meteora batch only after every signature is finalized', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-batch',
        submissionId: 'sub-2',
        submissionIds: ['sub-1', 'sub-2'],
        confirmationSignature: 'tx-2',
        confirmationSignatures: ['tx-1', 'tx-2'],
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'add-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
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

  it('treats unknown exit submissions without remaining wallet inventory as resolved exits', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-exit',
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'withdraw-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    });
  });

  it('treats an unknown deploy submission as resolved when fresh wallet tokens prove the mint exists', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-deploy',
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'deploy'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 42 }],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    });
  });

  it('treats an unknown open submission as resolved when a fresh Meteora lp position proves the mint exists', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-open',
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'add-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 69,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 69,
            hasLiquidity: true
          }
        ],
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    });
  });

  it('treats an unknown add-lp submission as resolved when a fully funded LP matches by pool address', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-open-pool',
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: '',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-1',
        orderAction: 'add-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 69,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 69,
            hasLiquidity: true
          }
        ],
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    });
  });

  it('treats a legacy unknown lp submission without orderAction as resolved when a fully funded LP matches by mint', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'legacy-k-open',
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:30:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        reason: 'broadcast-outcome-unknown'
      },
      now: new Date('2026-03-22T00:20:00.000Z'),
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 69,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 69,
            hasLiquidity: true
          }
        ],
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    });
  });

  it('keeps an add-lp submission blocked when the chain only shows a partially funded LP range', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-open-partial',
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'add-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 35,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 35,
            hasLiquidity: true
          }
        ],
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-recovery-required'
    });
  });

  it('treats a tracked withdraw-lp submission as resolved when the lp disappears and wallet tokens remain', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-withdraw',
        submissionId: 'sub-withdraw',
        confirmationSignature: 'tx-withdraw',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'withdraw-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [],
        journalLpPositions: [],
        walletTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 12 }],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    });
  });

  it('treats an unknown open submission as resolved even when lp evidence appears long after it was created', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-open-stale',
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:30:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'add-lp'
      },
      now: new Date('2026-03-22T00:20:00.000Z'),
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 69,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            binCount: 69,
            fundedBinCount: 69,
            hasLiquidity: true
          }
        ],
        walletTokens: [],
        journalTokens: [],
        fills: []
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

  it('keeps a partially failed Meteora batch blocked for repair instead of clearing it as a normal failure', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-partial',
        submissionId: 'sub-2',
        submissionIds: ['sub-1', 'sub-2'],
        confirmationSignature: 'tx-2',
        confirmationSignatures: ['tx-1', 'tx-2'],
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'add-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: submissionId === 'sub-1' ? 'confirmed' : 'failed',
          finality: submissionId === 'sub-1' ? 'finalized' : 'failed',
          checkedAt: '2026-03-22T00:01:00.000Z',
          reason: submissionId === 'sub-2' ? 'InstructionError' : undefined
        })
      }
    });

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-recovery-required',
      nextPendingSubmission: {
        reason: 'pending-submission-partial-failure'
      }
    });
  });
});
