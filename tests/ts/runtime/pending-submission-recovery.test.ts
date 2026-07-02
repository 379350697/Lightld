import { describe, expect, it } from 'vitest';

import { recoverPendingSubmission } from '../../../src/runtime/pending-submission-recovery';

describe('recoverPendingSubmission', () => {
  it('resolves and clears a pending submission after finalized confirmation', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k1',
        submissionId: 'sub-1',
        confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
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
          confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
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
        confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
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
            confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
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
        confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
        confirmationSignatures: ['4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm', '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u'],
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
        confirmationSignature: '5KcyrPXoh77aWuwnD7FP8bf9UT1313jajkZ3kBkwZgPAzEbNKGiXpo5Qf59JhZ1C1uSa12TFk2WYbmS1pnYjYioz',
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
        confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
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
          confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
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

  it('clears an untracked withdraw timeout as failed when the LP still exists', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-unknown-withdraw',
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:30.000Z',
        timeoutAt: '2026-03-22T00:01:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-safe',
        orderAction: 'withdraw-lp',
        reason: 'broadcast-outcome-unknown'
      },
      now: new Date('2026-03-22T00:02:00.000Z'),
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-safe',
          positionAddress: 'pos-safe',
          mint: 'mint-safe',
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-failed'
    });
  });

  it('clears a stale partial-failure reason once every tracked submission is finalized', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-partial-finalized',
        submissionId: 'sub-2',
        submissionIds: ['sub-1', 'sub-2'],
        confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
        confirmationSignatures: ['4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm', '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u'],
        confirmationStatus: 'confirmed',
        finality: 'finalized',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'withdraw-lp',
        reason: 'pending-submission-partial-failure'
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

  it('clears a partial-failure reduce-risk submission when wallet state shows no remaining position', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-partial-exit-terminal',
        submissionId: 'sub-2',
        submissionIds: ['sub-1', 'sub-2'],
        confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
        confirmationSignatures: ['4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm', '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u'],
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-safe',
        orderAction: 'withdraw-lp',
        reason: 'pending-submission-partial-failure'
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
      },
      accountState: {
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [],
        journalLpPositions: [],
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

  it('keeps a partially failed Meteora batch blocked for repair instead of clearing it as a normal failure', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-partial',
        submissionId: 'sub-2',
        submissionIds: ['sub-1', 'sub-2'],
        confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
        confirmationSignatures: ['4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm', '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u'],
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
