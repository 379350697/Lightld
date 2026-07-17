import { describe, expect, it, vi } from 'vitest';

import { recoverPendingSubmission } from '../../../src/runtime/pending-submission-recovery';

describe('recoverPendingSubmission', () => {
  it('clears a structured rejection with no accepted submission without polling', async () => {
    const poll = vi.fn();
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-policy-mismatch',
        submissionId: '',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-safe',
        orderAction: 'withdraw-lp',
        reason: 'broadcast-not-submitted: execution policy mismatch'
      },
      confirmationProvider: { poll },
      now: new Date('2026-03-22T00:01:00.000Z')
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-failed'
    });
    expect(poll).not.toHaveBeenCalled();
  });

  it('keeps a bare or accepted-outcome 409 fail-closed when no submission id is known', async () => {
    const basePending = {
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-idempotency-pending',
      submissionId: '',
      confirmationStatus: 'unknown' as const,
      finality: 'unknown' as const,
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:05:00.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      poolAddress: 'pool-safe',
      orderAction: 'withdraw-lp' as const
    };

    for (const reason of [
      'http-409',
      'idempotency key pending',
      'broadcast-outcome-unknown: execution policy mismatch'
    ]) {
      const result = await recoverPendingSubmission({
        pendingSubmission: { ...basePending, reason },
        now: new Date('2026-03-22T00:01:00.000Z')
      });

      expect(result).toMatchObject({
        blocked: true,
        resolved: false,
        clearPending: false,
        reason: 'pending-submission-recovery-required'
      });
    }
  });

  it('keeps a live unknown open fail-closed before timeout despite a fresh empty wallet snapshot', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        captureMode: 'live',
        idempotencyKey: 'k-live-open-before-timeout',
        submissionId: '',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-live',
        poolAddress: 'pool-live',
        orderAction: 'add-lp',
        reason: 'broadcast-outcome-unknown'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        observedAt: '2026-03-22T00:00:30.000Z',
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [],
        journalLpPositions: [],
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

  it('keeps a live unknown open fail-closed after timeout despite a fresh empty wallet snapshot', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        captureMode: 'live',
        idempotencyKey: 'k-live-open-after-timeout',
        submissionId: '',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:01:00.000Z',
        tokenMint: 'mint-live',
        poolAddress: 'pool-live',
        orderAction: 'add-lp',
        reason: 'broadcast-outcome-unknown'
      },
      now: new Date('2026-03-22T00:02:00.000Z'),
      accountState: {
        observedAt: '2026-03-22T00:01:30.000Z',
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-timeout'
    });
  });

  it('treats a legacy unknown open with no capture mode as live and keeps it fail-closed', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-legacy-unknown-open',
        submissionId: '',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:01:00.000Z',
        tokenMint: 'mint-legacy',
        poolAddress: 'pool-legacy',
        orderAction: 'add-lp',
        reason: 'broadcast-outcome-unknown'
      },
      now: new Date('2026-03-22T00:02:00.000Z'),
      accountState: {
        observedAt: '2026-03-22T00:01:30.000Z',
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-timeout'
    });
  });

  it('only clears an unknown paper open after timeout when the authoritative overlay remains empty', async () => {
    const pendingSubmission = {
      strategyId: 'new-token-v1',
      captureMode: 'mechanical-soak' as const,
      idempotencyKey: 'k-paper-open',
      submissionId: '',
      confirmationStatus: 'unknown' as const,
      finality: 'unknown' as const,
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:01:00.000Z',
      tokenMint: 'mint-paper',
      poolAddress: 'pool-paper',
      orderAction: 'add-lp' as const,
      reason: 'broadcast-outcome-unknown'
    };
    const accountState = {
      observedAt: '2026-03-22T00:00:30.000Z',
      walletSol: 2,
      journalSol: 2,
      walletLpPositions: [],
      journalLpPositions: [],
      walletTokens: [],
      journalTokens: [],
      fills: []
    };

    const beforeTimeout = await recoverPendingSubmission({
      pendingSubmission,
      now: new Date('2026-03-22T00:00:45.000Z'),
      accountState
    });
    const afterTimeout = await recoverPendingSubmission({
      pendingSubmission,
      now: new Date('2026-03-22T00:02:00.000Z'),
      accountState: {
        ...accountState,
        observedAt: '2026-03-22T00:01:30.000Z'
      }
    });

    expect(beforeTimeout).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-recovery-required'
    });
    expect(afterTimeout).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-failed'
    });
  });

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

  it('resolves a confirmed exact-in spot exit only after the exact raw token decrease is visible', async () => {
    const signature = '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm';
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'large-pool-v1',
        idempotencyKey: 'k-exact-dca-exit',
        submissionId: 'sub-exact-dca-exit',
        confirmationSignature: signature,
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        preExitTokenAmountRaw: '1000',
        inputAmountRaw: '400',
        orderAction: 'dca-out'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      confirmationProvider: {
        poll: async () => ({
          submissionId: 'sub-exact-dca-exit',
          confirmationSignature: signature,
          status: 'confirmed',
          finality: 'finalized',
          checkedAt: '2026-03-22T00:01:00.000Z'
        })
      },
      accountState: {
        observedAt: '2026-03-22T00:01:00.000Z',
        walletSol: 1.1,
        journalSol: 1.1,
        walletTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 600, amountRaw: '600' }],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      }
    });

    expect(result).toEqual({
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-confirmed'
    });
  });

  it('keeps a confirmed exact-in spot exit pending when the raw token decrease is partial', async () => {
    const signature = '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm';
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'large-pool-v1',
        idempotencyKey: 'k-partial-dca-exit',
        submissionId: 'sub-partial-dca-exit',
        confirmationSignature: signature,
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        preExitTokenAmountRaw: '1000',
        inputAmountRaw: '400',
        orderAction: 'dca-out'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      confirmationProvider: {
        poll: async () => ({
          submissionId: 'sub-partial-dca-exit',
          confirmationSignature: signature,
          status: 'confirmed',
          finality: 'finalized',
          checkedAt: '2026-03-22T00:01:00.000Z'
        })
      },
      accountState: {
        observedAt: '2026-03-22T00:01:00.000Z',
        walletSol: 1.05,
        journalSol: 1.05,
        walletTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 700, amountRaw: '700' }],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      }
    });

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-recovery-required',
      nextPendingSubmission: {
        confirmationStatus: 'confirmed',
        finality: 'finalized',
        reason: 'pending-dca-awaiting-exact-token-delta:token-delta-mismatch'
      }
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

  it('does not close an unknown LP exit from mint-only negative evidence', async () => {
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
        observedAt: '2026-03-22T00:01:00.000Z',
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [],
        journalLpPositions: [],
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

  it('does not use an incomplete account snapshot as negative exit evidence', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-exit-incomplete',
        submissionId: '',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-safe',
        chainPositionAddress: 'position-safe',
        orderAction: 'withdraw-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        observedAt: '2026-03-22T00:01:00.000Z',
        walletSol: 2,
        journalSol: 2,
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

  it('does not resolve reduce-risk pending submissions without account evidence', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-exit',
        submissionId: 'sub-exit',
        confirmationStatus: 'submitted',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'withdraw-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z')
    });

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-recovery-required'
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
        observedAt: '2026-03-22T00:01:00.000Z',
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [],
        journalLpPositions: [],
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

  it('keeps a confirmed withdraw pending while the exact chain position still exists', async () => {
    const signature = '5KcyrPXoh77aWuwnD7FP8bf9UT1313jajkZ3kBkwZgPAzEbNKGiXpo5Qf59JhZ1C1uSa12TFk2WYbmS1pnYjYioz';
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-confirmed-still-open',
        submissionId: 'sub-confirmed-still-open',
        confirmationSignature: signature,
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        timeoutAt: '2026-03-22T00:05:00.000Z',
        tokenMint: 'mint-safe',
        poolAddress: 'pool-safe',
        chainPositionAddress: 'position-safe',
        orderAction: 'withdraw-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      confirmationProvider: {
        poll: async () => ({
          submissionId: 'sub-confirmed-still-open',
          confirmationSignature: signature,
          status: 'confirmed',
          finality: 'finalized',
          checkedAt: '2026-03-22T00:01:00.000Z'
        })
      },
      accountState: {
        observedAt: '2026-03-22T00:01:00.000Z',
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [{
          poolAddress: 'pool-safe',
          positionAddress: 'position-safe',
          mint: 'mint-safe',
          hasLiquidity: true
        }],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-recovery-required',
      nextPendingSubmission: {
        confirmationStatus: 'confirmed',
        finality: 'finalized',
        reason: 'pending-withdraw-awaiting-account-closure-proof'
      }
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
        observedAt: '2026-03-22T00:01:00.000Z',
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
        observedAt: '2026-03-22T00:01:00.000Z',
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
        observedAt: '2026-03-22T00:01:00.000Z',
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
        poolAddress: 'pool-safe',
        chainPositionAddress: 'position-safe',
        orderAction: 'withdraw-lp'
      },
      now: new Date('2026-03-22T00:01:00.000Z'),
      accountState: {
        observedAt: '2026-03-22T00:01:00.000Z',
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
        observedAt: '2026-03-22T00:20:00.000Z',
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
        captureMode: 'mechanical-soak',
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
        observedAt: '2026-03-22T00:02:00.000Z',
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

  it('keeps a timed-out live withdraw fail-closed even when the exact LP still exists', async () => {
    const result = await recoverPendingSubmission({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        captureMode: 'live',
        idempotencyKey: 'k-live-unknown-withdraw',
        submissionId: '',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:30.000Z',
        timeoutAt: '2026-03-22T00:01:00.000Z',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-safe',
        chainPositionAddress: 'pos-safe',
        orderAction: 'withdraw-lp',
        reason: 'idempotency key pending'
      },
      now: new Date('2026-03-22T00:02:00.000Z'),
      accountState: {
        observedAt: '2026-03-22T00:02:00.000Z',
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

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-timeout'
    });
  });

  it('keeps a partial batch pending even when every tracked submission is finalized', async () => {
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
        batchStatus: 'partial',
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

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-recovery-required',
      nextPendingSubmission: {
        batchStatus: 'partial',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        reason: 'pending-submission-partial-failure'
      }
    });
  });

  it('keeps a partial reduce-risk batch pending even when wallet state shows no remaining position', async () => {
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
        batchStatus: 'partial',
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
        observedAt: '2026-03-22T00:01:00.000Z',
        walletSol: 2,
        journalSol: 2,
        walletLpPositions: [],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    expect(result).toMatchObject({
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-recovery-required',
      nextPendingSubmission: {
        batchStatus: 'partial',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        reason: 'pending-submission-partial-failure'
      }
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
