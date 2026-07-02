import { describe, expect, it } from 'vitest';

import { runAccountReconciliationGate, runPendingRecoveryGate } from '../../../src/runtime/live-cycle-preflight';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';

describe('live-cycle preflight helpers', () => {
  it('advances lifecycle after confirmed pending LP exit recovery', async () => {
    const store = {
      clear: async () => {},
      write: async () => {}
    } as unknown as PendingSubmissionStore;

    const result = await runPendingRecoveryGate({
      pendingSubmissionStore: store,
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k',
        submissionId: 'sub-1',
        confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed',
          finality: 'finalized',
          checkedAt: '2026-03-22T00:00:05.000Z'
        })
      },
      currentLifecycleState: 'lp_exit_pending'
    });

    expect(result.blocked).toBe(false);
    expect(result.lifecycleState).toBe('inventory_exit_ready');
  });

  it('closes a recovered LP exit when the wallet has no LP or token inventory left', async () => {
    const store = {
      clear: async () => {},
      write: async () => {}
    } as unknown as PendingSubmissionStore;

    const result = await runPendingRecoveryGate({
      pendingSubmissionStore: store,
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-flat-exit',
        submissionId: 'sub-1',
        confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
        confirmationStatus: 'submitted',
        finality: 'processed',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        orderAction: 'withdraw-lp',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed',
          finality: 'finalized',
          checkedAt: '2026-03-22T00:00:05.000Z'
        })
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      currentLifecycleState: 'lp_exit_pending'
    });

    expect(result.blocked).toBe(false);
    expect(result.lifecycleState).toBe('closed');
  });

  it('promotes open_pending to open after confirmed open recovery', async () => {
    const store = {
      clear: async () => {},
      write: async () => {}
    } as unknown as PendingSubmissionStore;

    const result = await runPendingRecoveryGate({
      pendingSubmissionStore: store,
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-open',
        submissionId: 'sub-open',
        confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed',
          finality: 'finalized',
          checkedAt: '2026-03-22T00:00:05.000Z'
        })
      },
      currentLifecycleState: 'open_pending'
    });

    expect(result.blocked).toBe(false);
    expect(result.lifecycleState).toBe('open');
  });

  it('drops open_pending back to closed after failed open recovery', async () => {
    const store = {
      clear: async () => {},
      write: async () => {}
    } as unknown as PendingSubmissionStore;

    const result = await runPendingRecoveryGate({
      pendingSubmissionStore: store,
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-open',
        submissionId: 'sub-open',
        confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'failed',
          finality: 'failed',
          checkedAt: '2026-03-22T00:00:05.000Z'
        })
      },
      currentLifecycleState: 'open_pending'
    });

    expect(result.blocked).toBe(false);
    expect(result.lifecycleState).toBe('closed');
  });

  it('drops stale open_pending back to closed when no wallet evidence exists', async () => {
    let cleared = false;
    const store = {
      clear: async () => {
        cleared = true;
      },
      write: async () => {}
    } as unknown as PendingSubmissionStore;

    const result = await runPendingRecoveryGate({
      pendingSubmissionStore: store,
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-stale',
        submissionId: 'sub-stale',
        confirmationSignature: 'tx-stale',
        confirmationStatus: 'submitted',
        finality: 'unknown',
        tokenMint: 'mint-stale',
        orderAction: 'add-lp',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      now: new Date('2026-03-22T00:01:01.000Z'),
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      currentLifecycleState: 'open_pending'
    });

    expect(cleared).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.lifecycleState).toBe('closed');
  });

  it('clears an untracked timed-out LP exit and returns the lifecycle to open', async () => {
    let cleared = false;
    const store = {
      clear: async () => {
        cleared = true;
      },
      write: async () => {}
    } as unknown as PendingSubmissionStore;

    const result = await runPendingRecoveryGate({
      pendingSubmissionStore: store,
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-unknown-exit',
        submissionId: '',
        confirmationSignature: undefined,
        confirmationStatus: 'unknown',
        finality: 'unknown',
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-safe',
        orderAction: 'withdraw-lp',
        reason: 'broadcast-outcome-unknown',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:30.000Z',
        timeoutAt: '2026-03-22T00:01:00.000Z'
      },
      now: new Date('2026-03-22T00:02:00.000Z'),
      accountState: {
        walletSol: 1,
        journalSol: 1,
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
      },
      currentLifecycleState: 'lp_exit_pending'
    });

    expect(cleared).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBe('pending-submission-failed');
    expect(result.lifecycleState).toBe('open');
  });

  it('treats pool-matched LP evidence as a successful open recovery', async () => {
    let cleared = false;
    const store = {
      clear: async () => {
        cleared = true;
      },
      write: async () => {}
    } as unknown as PendingSubmissionStore;

    const result = await runPendingRecoveryGate({
      pendingSubmissionStore: store,
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'k-pool',
        submissionId: '',
        confirmationStatus: 'unknown',
        finality: 'unknown',
        tokenMint: '',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-1',
        orderAction: 'add-lp',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      now: new Date('2026-03-22T00:00:10.000Z'),
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-1',
          positionAddress: 'pos-1',
          mint: 'mint-safe',
          binCount: 69,
          fundedBinCount: 69,
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      },
      currentLifecycleState: 'open_pending'
    });

    expect(cleared).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.lifecycleState).toBe('open');
  });

  it('returns reconciliation result when account state is present', () => {
    const result = runAccountReconciliationGate({
      walletSol: 1,
      journalSol: 1,
      walletTokens: [],
      journalTokens: [],
      fills: []
    });

    expect(result).toMatchObject({
      ok: true,
      reason: 'matched'
    });
  });
});
