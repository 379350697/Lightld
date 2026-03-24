import { describe, expect, it } from 'vitest';

import { shouldBlockForRecovery } from '../../../src/runtime/recovery-gate';

describe('shouldBlockForRecovery', () => {
  it('blocks new submission when a prior submission is unresolved', () => {
    expect(
      shouldBlockForRecovery({
        pendingSubmission: {
          strategyId: 'new-token-v1',
          idempotencyKey: 'k1',
          submissionId: 'sub-1',
          confirmationStatus: 'submitted',
          createdAt: '2026-03-22T00:00:00.000Z',
          updatedAt: '2026-03-22T00:00:00.000Z'
        }
      })
    ).toEqual({
      blocked: true,
      reason: 'pending-submission-recovery-required'
    });
  });

  it('allows new execution once the pending submission is resolved', () => {
    expect(
      shouldBlockForRecovery({
        pendingSubmission: {
          strategyId: 'new-token-v1',
          idempotencyKey: 'k1',
          submissionId: 'sub-1',
          confirmationStatus: 'confirmed',
          createdAt: '2026-03-22T00:00:00.000Z',
          updatedAt: '2026-03-22T00:01:00.000Z'
        }
      })
    ).toEqual({
      blocked: false,
      reason: 'clear'
    });
  });
});
