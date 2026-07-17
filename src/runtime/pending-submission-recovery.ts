import type { LiveConfirmationProvider } from '../execution/live-confirmation-provider.ts';
import type { LiveAccountState } from './live-account-provider.ts';
import type { PendingSubmissionSnapshot } from './state-types.ts';
import { classifyAction } from './action-semantics.ts';
import { isSolanaTransactionSignature } from '../shared/solana-signature.ts';
import {
  hasAnyWalletEvidenceForPendingSubmission,
  hasCompleteFreshAccountSnapshot,
  hasFreshCompleteLpExitAbsenceEvidence,
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

function hasCompleteFreshNegativeEvidence(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
) {
  return hasCompleteFreshAccountSnapshot(pendingSubmission, accountState);
}

function isPartialBatch(pendingSubmission: PendingSubmissionSnapshot) {
  return pendingSubmission.batchStatus === 'partial'
    || pendingSubmission.reason === 'pending-submission-partial-failure'
    || pendingSubmission.reason?.startsWith('pending-submission-partial-failure:') === true;
}

function isExplicitlyNotSubmitted(
  pendingSubmission: PendingSubmissionSnapshot
) {
  if (
    pendingSubmission.submissionId
    || pendingSubmission.submissionIds?.some((submissionId) => submissionId.length > 0)
  ) {
    return false;
  }

  const reason = (pendingSubmission.reason ?? '').toLowerCase();
  return reason === 'broadcast-not-submitted'
    || reason.startsWith('broadcast-not-submitted:');
}

function unresolvedPartialBatch(
  pendingSubmission: PendingSubmissionSnapshot
): PendingSubmissionRecoveryResult {
  return {
    blocked: true,
    resolved: false,
    clearPending: false,
    reason: 'pending-submission-recovery-required',
    nextPendingSubmission: {
      ...pendingSubmission,
      batchStatus: 'partial',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      reason: 'pending-submission-partial-failure'
    }
  };
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
  // Negative wallet evidence is only terminal for the local paper overlay.
  // A live transaction can be accepted without returning a submission id and
  // land after an otherwise fresh account snapshot, so live must remain
  // fail-closed until positive chain/execution evidence or manual recovery.
  if (
    pendingSubmission.captureMode !== 'mechanical-soak'
    && pendingSubmission.captureMode !== 'economic-shadow'
  ) {
    return false;
  }

  if (!hasCompleteFreshNegativeEvidence(pendingSubmission, accountState)) {
    return false;
  }

  if (
    pendingSubmission.submissionId
    || pendingSubmission.submissionIds?.some((submissionId) => submissionId.length > 0)
    || hasAnyWalletEvidenceForPendingSubmission(pendingSubmission, accountState)
  ) {
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
  if (!hasCompleteFreshNegativeEvidence(pendingSubmission, accountState)) {
    return false;
  }

  if (pendingSubmission.submissionId || hasAnyWalletEvidenceForPendingSubmission(pendingSubmission, accountState)) {
    return false;
  }

  if (!pendingSubmission.orderAction) {
    return false;
  }

  return classifyAction(pendingSubmission.orderAction) === 'reduce_risk';
}

function isUntrackedReduceRiskFailure(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
) {
  if (
    pendingSubmission.captureMode !== 'mechanical-soak'
    && pendingSubmission.captureMode !== 'economic-shadow'
  ) {
    return false;
  }

  if (!hasCompleteFreshNegativeEvidence(pendingSubmission, accountState)) {
    return false;
  }

  if (pendingSubmission.submissionId || !hasAnyWalletEvidenceForPendingSubmission(pendingSubmission, accountState)) {
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
  if (!hasCompleteFreshNegativeEvidence(pendingSubmission, accountState)) {
    return false;
  }

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
  if (!hasCompleteFreshNegativeEvidence(pendingSubmission, accountState)) {
    return false;
  }

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

type DcaExitTokenDeltaEvidence =
  | 'proven'
  | 'account-snapshot-unavailable'
  | 'ownership-baseline-missing'
  | 'post-exit-token-raw-unavailable'
  | 'token-delta-mismatch';

function sumWalletTokenAmountRaw(
  accountState: LiveAccountState | undefined,
  tokenMint: string | undefined
) {
  if (!accountState || !tokenMint || !Array.isArray(accountState.walletTokens)) {
    return undefined;
  }

  let total = 0n;
  for (const token of accountState.walletTokens) {
    if (token.mint !== tokenMint) {
      continue;
    }

    const amountRaw = token.amountRaw
      ?? (typeof token.amountLamports === 'number'
        && Number.isSafeInteger(token.amountLamports)
        && token.amountLamports >= 0
        ? String(token.amountLamports)
        : undefined);
    if (!amountRaw || !/^\d+$/.test(amountRaw)) {
      return undefined;
    }
    total += BigInt(amountRaw);
  }

  return total;
}

function resolveDcaExitTokenDeltaEvidence(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
): DcaExitTokenDeltaEvidence {
  if (!hasCompleteFreshAccountSnapshot(pendingSubmission, accountState)) {
    return 'account-snapshot-unavailable';
  }
  if (
    !pendingSubmission.tokenMint
    || pendingSubmission.preExitTokenAmountRaw === undefined
    || pendingSubmission.inputAmountRaw === undefined
  ) {
    return 'ownership-baseline-missing';
  }

  const postExitRaw = sumWalletTokenAmountRaw(accountState, pendingSubmission.tokenMint);
  if (postExitRaw === undefined) {
    return 'post-exit-token-raw-unavailable';
  }

  const preExitRaw = BigInt(pendingSubmission.preExitTokenAmountRaw);
  const expectedDisposedRaw = BigInt(pendingSubmission.inputAmountRaw);
  if (preExitRaw < expectedDisposedRaw || preExitRaw - postExitRaw !== expectedDisposedRaw) {
    return 'token-delta-mismatch';
  }

  return 'proven';
}

function pendingDcaExitEvidenceReason(evidence: Exclude<DcaExitTokenDeltaEvidence, 'proven'>) {
  return `pending-dca-awaiting-exact-token-delta:${evidence}`;
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

function resolveTerminalWalletRecoveryReason(
  pendingSubmission: PendingSubmissionSnapshot,
  accountState: LiveAccountState | undefined
): PendingSubmissionRecoveryResult['reason'] | undefined {
  // A withdraw transaction (or a fill row) is not proof that the exact LP
  // account disappeared.  Only a complete post-submit account snapshot with
  // that chain position absent can close the lifecycle.
  if (pendingSubmission.orderAction === 'withdraw-lp') {
    return hasFreshCompleteLpExitAbsenceEvidence(pendingSubmission, accountState)
      ? 'pending-submission-filled'
      : undefined;
  }

  // Confirmation or a generic fill row is not enough to close an exact-in
  // strategy-owned spot exit.  A fresh complete account snapshot must prove
  // that precisely inputAmountRaw disappeared from the wallet-wide raw
  // balance, preserving any pre-existing same-mint personal inventory.
  if (pendingSubmission.orderAction === 'dca-out') {
    return resolveDcaExitTokenDeltaEvidence(pendingSubmission, accountState) === 'proven'
      ? 'pending-submission-filled'
      : undefined;
  }

  if (
    pendingSubmission.orderAction === 'claim-fee'
    && !hasCompleteFreshAccountSnapshot(pendingSubmission, accountState)
  ) {
    return undefined;
  }

  if (
    pendingSubmission.orderAction === 'claim-fee'
    && pendingSubmission.confirmationStatus === 'confirmed'
    && (pendingSubmission.finality === 'confirmed' || pendingSubmission.finality === 'finalized')
  ) {
    return 'pending-submission-confirmed';
  }

  if (hasMatchingFill(pendingSubmission, accountState)) {
    return 'pending-submission-filled';
  }

  if (hasFreshOpenWalletEvidence(pendingSubmission, accountState)) {
    return 'pending-submission-filled';
  }

  if (hasFreshReduceRiskWalletEvidence(pendingSubmission, accountState)) {
    return 'pending-submission-filled';
  }

  if (hasLegacyFullyFundedLpEvidence(pendingSubmission, accountState)) {
    return 'pending-submission-filled';
  }

  if (isUnknownExitFill(pendingSubmission, accountState)) {
    return 'pending-submission-filled';
  }

  return undefined;
}

function resolvedRecovery(reason: PendingSubmissionRecoveryResult['reason']): PendingSubmissionRecoveryResult {
  return {
    blocked: false,
    resolved: true,
    clearPending: true,
    reason
  };
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

  // A structured pre-submit rejection has no chain outcome to poll. Clear it
  // immediately so a failed exit returns to the ordinary open/exit loop. Do
  // not infer this from a bare HTTP 409: `idempotency key pending` is an
  // accepted request with an unknown outcome and must remain fail-closed.
  if (isExplicitlyNotSubmitted(input.pendingSubmission)) {
    return resolvedRecovery('pending-submission-failed');
  }

  const checkedAt = nowIso(input.now);
  let nextPendingSubmission = {
    ...input.pendingSubmission,
    updatedAt: checkedAt
  };

  const trackedSubmissions = getTrackedSubmissions(input.pendingSubmission);

  if (input.confirmationProvider && trackedSubmissions.length > 0) {
    const confirmations = await Promise.all(
      trackedSubmissions.map((trackedSubmission) => {
        if (!isSolanaTransactionSignature(trackedSubmission.confirmationSignature)) {
          return { submissionId: trackedSubmission.submissionId, confirmationSignature: trackedSubmission.confirmationSignature, status: 'unknown' as const, finality: 'unknown' as const, checkedAt: checkedAt };
        }
        return input.confirmationProvider!.poll(trackedSubmission);
      })
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
    const latestReason = confirmations.find(
      (confirmation): confirmation is typeof confirmation & { reason: string } =>
        'reason' in confirmation && typeof confirmation.reason === 'string'
    )?.reason;

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

    if (isPartialBatch(nextPendingSubmission)) {
      return unresolvedPartialBatch(nextPendingSubmission);
    }

    if (allConfirmed) {
      if (nextPendingSubmission.orderAction === 'dca-out') {
        const dcaExitEvidence = resolveDcaExitTokenDeltaEvidence(
          nextPendingSubmission,
          input.accountState
        );
        if (dcaExitEvidence === 'proven') {
          return resolvedRecovery('pending-submission-confirmed');
        }
        return {
          blocked: true,
          resolved: false,
          clearPending: false,
          reason: 'pending-submission-recovery-required',
          nextPendingSubmission: {
            ...nextPendingSubmission,
            reason: pendingDcaExitEvidenceReason(dcaExitEvidence)
          }
        };
      }

      if (nextPendingSubmission.orderAction !== 'withdraw-lp') {
        if (
          nextPendingSubmission.orderAction === 'claim-fee'
          && !hasCompleteFreshAccountSnapshot(nextPendingSubmission, input.accountState)
        ) {
          return {
            blocked: true,
            resolved: false,
            clearPending: false,
            reason: 'pending-submission-recovery-required',
            nextPendingSubmission: {
              ...nextPendingSubmission,
              reason: 'pending-claim-awaiting-account-residual-proof'
            }
          };
        }
        return resolvedRecovery('pending-submission-confirmed');
      }

      if (hasFreshCompleteLpExitAbsenceEvidence(nextPendingSubmission, input.accountState)) {
        return resolvedRecovery('pending-submission-confirmed');
      }

      return {
        blocked: true,
        resolved: false,
        clearPending: false,
        reason: 'pending-submission-recovery-required',
        nextPendingSubmission: {
          ...nextPendingSubmission,
          reason: 'pending-withdraw-awaiting-account-closure-proof'
        }
      };
    }

    const terminalWalletReason = resolveTerminalWalletRecoveryReason(
      nextPendingSubmission,
      input.accountState
    );
    if (terminalWalletReason) {
      return resolvedRecovery(terminalWalletReason);
    }

    if (allFailed || (anyFailed && !anySucceeded)) {
      return resolvedRecovery('pending-submission-failed');
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

    if (nextPendingSubmission.reason === 'pending-submission-partial-failure') {
      return {
        blocked: true,
        resolved: false,
        clearPending: false,
        reason: 'pending-submission-recovery-required',
        nextPendingSubmission
      };
    }
  }

  if (isPartialBatch(nextPendingSubmission)) {
    return unresolvedPartialBatch(nextPendingSubmission);
  }

  const terminalWalletReason = resolveTerminalWalletRecoveryReason(nextPendingSubmission, input.accountState);
  if (terminalWalletReason) {
    return resolvedRecovery(terminalWalletReason);
  }

  if (nextPendingSubmission.timeoutAt && nextPendingSubmission.timeoutAt <= checkedAt) {
    // Only a timed-out paper open can be disproved by the authoritative local
    // overlay being absent. Never release live open-risk capacity from a
    // short-lived negative wallet snapshot after an unknown broadcast.
    if (isUnknownOpenFailure(nextPendingSubmission, input.accountState)) {
      return resolvedRecovery('pending-submission-failed');
    }

    if (isUntrackedReduceRiskFailure(nextPendingSubmission, input.accountState)) {
      return resolvedRecovery('pending-submission-failed');
    }

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
