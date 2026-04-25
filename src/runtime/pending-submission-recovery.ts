import type { LiveConfirmationProvider } from '../execution/live-confirmation-provider.ts';
import type { LiveAccountState } from './live-account-provider.ts';
import type { PendingSubmissionSnapshot } from './state-types.ts';
import { classifyAction } from './action-semantics.ts';
import {
  hasAnyWalletEvidenceForPendingSubmission,
  hasFullyFundedWalletLpEvidence,
  hasWalletLpEvidence,
  hasWalletTokenEvidence
} from './pending-submission-wallet-evidence.ts';

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
    const fillAmount = typeof fill.amount === 'number' ? fill.amount : 0;
    const hasExecutedAmount = fillAmount > 0;
    if (!hasExecutedAmount) {
      return false;
    }

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

function getTrackedSubmissions(pendingSubmission: PendingSubmissionSnapshot) {
  const submissionIds = pendingSubmission.submissionIds?.filter((submissionId) => submissionId.length > 0) ?? [];
  const confirmationSignatures = pendingSubmission.confirmationSignatures ?? [];

  if (submissionIds.length > 0) {
    return submissionIds.map((submissionId, index) => ({
      submissionId,
      confirmationSignature:
        confirmationSignatures[index] ??
        (submissionId === pendingSubmission.submissionId ? pendingSubmission.confirmationSignature : undefined)
    }));
  }

  if (!pendingSubmission.submissionId) {
    return [];
  }

  return [{
    submissionId: pendingSubmission.submissionId,
    confirmationSignature: pendingSubmission.confirmationSignature
  }];
}

function isUnknownOpenFailure(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
) {
  if (pendingSubmission.submissionId || hasAnyWalletEvidenceForPendingSubmission(pendingSubmission, accountState)) {
    return false;
  }

  if (!pendingSubmission.orderAction) {
    return false;
  }

  return classifyAction(pendingSubmission.orderAction) === 'open_risk';
}

function isUnknownExitFill(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
) {
  if (pendingSubmission.submissionId || hasAnyWalletEvidenceForPendingSubmission(pendingSubmission, accountState)) {
    return false;
  }

  if (!pendingSubmission.orderAction) {
    return false;
  }

  return classifyAction(pendingSubmission.orderAction) === 'reduce_risk';
}

function hasFreshOpenWalletEvidence(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
) {
  if ((!pendingSubmission.tokenMint && !pendingSubmission.poolAddress) || !pendingSubmission.orderAction) {
    return false;
  }

  if (classifyAction(pendingSubmission.orderAction) !== 'open_risk') {
    return false;
  }

  if (pendingSubmission.orderAction === 'add-lp') {
    return hasFullyFundedWalletLpEvidence(pendingSubmission, accountState);
  }

  return hasWalletTokenEvidence(pendingSubmission.tokenMint, accountState) ||
    hasWalletLpEvidence(pendingSubmission, accountState);
}

function hasFreshReduceRiskWalletEvidence(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
) {
  if (!pendingSubmission.tokenMint || !pendingSubmission.orderAction) {
    return false;
  }

  if (classifyAction(pendingSubmission.orderAction) !== 'reduce_risk') {
    return false;
  }

  const hasToken = hasWalletTokenEvidence(pendingSubmission.tokenMint, accountState);
  const hasLp = hasWalletLpEvidence(pendingSubmission, accountState);

  if (pendingSubmission.orderAction === 'withdraw-lp') {
    return !hasLp;
  }

  if (pendingSubmission.orderAction === 'dca-out') {
    return !hasToken && !hasLp;
  }

  return false;
}

function hasLegacyFullyFundedLpEvidence(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
) {
  if (pendingSubmission.orderAction) {
    return false;
  }

  return hasFullyFundedWalletLpEvidence(pendingSubmission, accountState);
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

  const trackedSubmissions = getTrackedSubmissions(input.pendingSubmission);

  if (input.confirmationProvider && trackedSubmissions.length > 0) {
    const confirmations = await Promise.all(
      trackedSubmissions.map((trackedSubmission) => input.confirmationProvider!.poll(trackedSubmission))
    );

    const allConfirmed = confirmations.every((confirmation) =>
      confirmation.status === 'confirmed' &&
      (confirmation.finality === 'confirmed' || confirmation.finality === 'finalized')
    );
    const allFailed = confirmations.every((confirmation) =>
      confirmation.status === 'failed' || confirmation.finality === 'failed'
    );
    const anyFailed = confirmations.some((confirmation) =>
      confirmation.status === 'failed' || confirmation.finality === 'failed'
    );
    const anySucceeded = confirmations.some((confirmation) =>
      confirmation.status === 'confirmed' &&
      (confirmation.finality === 'confirmed' || confirmation.finality === 'finalized')
    );
    const latestCheckedAt = confirmations.reduce((latest, confirmation) =>
      confirmation.checkedAt > latest ? confirmation.checkedAt : latest, checkedAt
    );
    const latestReason = confirmations.find((confirmation) => confirmation.reason)?.reason;

    nextPendingSubmission = {
      ...nextPendingSubmission,
      confirmationStatus: allConfirmed ? 'confirmed' : allFailed ? 'failed' : 'submitted',
      finality: allConfirmed
        ? (confirmations.every((confirmation) => confirmation.finality === 'finalized') ? 'finalized' : 'confirmed')
        : allFailed
          ? 'failed'
          : 'unknown',
      lastCheckedAt: latestCheckedAt,
      updatedAt: latestCheckedAt,
      reason: latestReason ?? nextPendingSubmission.reason,
      submissionIds: confirmations.map((confirmation) => confirmation.submissionId),
      confirmationSignatures: confirmations.map((confirmation, index) =>
        confirmation.confirmationSignature ?? trackedSubmissions[index]?.confirmationSignature ?? confirmation.submissionId
      ),
      confirmationSignature:
        confirmations[confirmations.length - 1]?.confirmationSignature ?? nextPendingSubmission.confirmationSignature,
      submissionId: confirmations[confirmations.length - 1]?.submissionId ?? nextPendingSubmission.submissionId
    };

    if (nextPendingSubmission.reason === 'pending-submission-partial-failure') {
      return {
        blocked: true,
        resolved: false,
        clearPending: false,
        reason: 'pending-submission-recovery-required',
        nextPendingSubmission
      };
    }

    if (allConfirmed) {
      return {
        blocked: false,
        resolved: true,
        clearPending: true,
        reason: 'pending-submission-confirmed'
      };
    }

    if (anyFailed && trackedSubmissions.length > 1 && !allFailed) {
      return {
        blocked: true,
        resolved: false,
        clearPending: false,
        reason: 'pending-submission-recovery-required',
        nextPendingSubmission: {
          ...nextPendingSubmission,
          confirmationStatus: 'unknown',
          finality: 'unknown',
          reason: 'pending-submission-partial-failure'
        }
      };
    }

    if (allFailed || (anyFailed && !anySucceeded)) {
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

  if (hasFreshOpenWalletEvidence(nextPendingSubmission, input.accountState)) {
    return {
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    };
  }

  if (hasFreshReduceRiskWalletEvidence(nextPendingSubmission, input.accountState)) {
    return {
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    };
  }

  if (hasLegacyFullyFundedLpEvidence(nextPendingSubmission, input.accountState)) {
    return {
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    };
  }

  if (isUnknownExitFill(nextPendingSubmission, input.accountState)) {
    return {
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-filled'
    };
  }

  if (isUnknownOpenFailure(nextPendingSubmission, input.accountState)) {
    return {
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-failed'
    };
  }

  if (nextPendingSubmission.timeoutAt && nextPendingSubmission.timeoutAt <= checkedAt) {
    return {
      blocked: false,
      resolved: true,
      clearPending: true,
      reason: 'pending-submission-failed'
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
