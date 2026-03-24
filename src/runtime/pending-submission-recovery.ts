import type { LiveConfirmationProvider } from '../execution/live-confirmation-provider.ts';
import type { LiveAccountState } from './live-account-provider.ts';
import type { PendingSubmissionSnapshot } from './state-types.ts';

type PendingSubmissionRecoveryInput = {
  pendingSubmission: PendingSubmissionSnapshot | null;
  confirmationProvider?: LiveConfirmationProvider;
  accountState?: LiveAccountState;
  now?: Date;
};

type PendingSubmissionRecoveryResult = {
  blocked: boolean;
  resolved: boolean;
  clearPending: boolean;
  reason:
    | 'clear'
    | 'pending-submission-confirmed'
    | 'pending-submission-failed'
    | 'pending-submission-filled'
    | 'pending-submission-recovery-required'
    | 'pending-submission-timeout';
  nextPendingSubmission?: PendingSubmissionSnapshot;
};

function nowIso(now?: Date) {
  return (now ?? new Date()).toISOString();
}

function hasMatchingFill(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
) {
  if (!accountState?.fills?.length) {
    return false;
  }

  return accountState.fills.some((fill) => {
    if (
      pendingSubmission.confirmationSignature &&
      fill.confirmationSignature &&
      fill.confirmationSignature === pendingSubmission.confirmationSignature
    ) {
      return true;
    }

    if (
      pendingSubmission.submissionId &&
      fill.submissionId &&
      fill.submissionId === pendingSubmission.submissionId
    ) {
      return true;
    }

    return false;
  });
}

export async function recoverPendingSubmission(
  input: PendingSubmissionRecoveryInput
): Promise<PendingSubmissionRecoveryResult> {
  if (!input.pendingSubmission) {
    return {
      blocked: false,
      resolved: true,
      clearPending: false,
      reason: 'clear'
    };
  }

  const checkedAt = nowIso(input.now);
  let nextPendingSubmission = {
    ...input.pendingSubmission,
    updatedAt: checkedAt
  };

  if (input.confirmationProvider && input.pendingSubmission.submissionId) {
    const confirmation = await input.confirmationProvider.poll({
      submissionId: input.pendingSubmission.submissionId,
      confirmationSignature: input.pendingSubmission.confirmationSignature
    });

    nextPendingSubmission = {
      ...nextPendingSubmission,
      confirmationStatus: confirmation.status,
      finality: confirmation.finality,
      lastCheckedAt: confirmation.checkedAt,
      updatedAt: confirmation.checkedAt,
      reason: confirmation.reason ?? nextPendingSubmission.reason,
      confirmationSignature:
        confirmation.confirmationSignature ?? nextPendingSubmission.confirmationSignature
    };

    if (
      confirmation.status === 'confirmed' &&
      (confirmation.finality === 'confirmed' || confirmation.finality === 'finalized')
    ) {
      return {
        blocked: false,
        resolved: true,
        clearPending: true,
        reason: 'pending-submission-confirmed'
      };
    }

    if (confirmation.status === 'failed' || confirmation.finality === 'failed') {
      return {
        blocked: false,
        resolved: true,
        clearPending: true,
        reason: 'pending-submission-failed'
      };
    }
  }

  if (hasMatchingFill(nextPendingSubmission, input.accountState)) {
    return {
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    };
  }

  if (nextPendingSubmission.timeoutAt && nextPendingSubmission.timeoutAt <= checkedAt) {
    return {
      blocked: true,
      resolved: false,
      clearPending: false,
      reason: 'pending-submission-timeout',
      nextPendingSubmission
    };
  }

  return {
    blocked: true,
    resolved: false,
    clearPending: false,
    reason: 'pending-submission-recovery-required',
    nextPendingSubmission
  };
}
