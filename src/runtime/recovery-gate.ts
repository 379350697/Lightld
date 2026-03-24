import type { PendingSubmissionSnapshot } from './state-types.ts';

export function shouldBlockForRecovery(input: {
  pendingSubmission: PendingSubmissionSnapshot | null;
}) {
  if (
    input.pendingSubmission &&
    (input.pendingSubmission.confirmationStatus === 'submitted' ||
      input.pendingSubmission.confirmationStatus === 'unknown')
  ) {
    return {
      blocked: true as const,
      reason: 'pending-submission-recovery-required' as const
    };
  }

  return {
    blocked: false as const,
    reason: 'clear' as const
  };
}
