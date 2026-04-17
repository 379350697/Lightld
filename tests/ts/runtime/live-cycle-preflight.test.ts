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
        confirmationSignature: 'tx-1',
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
        confirmationSignature: 'tx-open',
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
        confirmationSignature: 'tx-open',
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
      now: new Date('2026-03-22T00:00:10.000Z'),
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
