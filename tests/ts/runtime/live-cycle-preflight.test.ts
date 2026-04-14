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
