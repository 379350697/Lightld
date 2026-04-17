import type { LiveConfirmationProvider } from '../execution/live-confirmation-provider.ts';
import type { LiveAccountState } from './live-account-provider.ts';
import { recoverPendingSubmission } from './pending-submission-recovery.ts';
import { PendingSubmissionStore } from './pending-submission-store.ts';
import { reconcileLiveState } from './reconcile-live-state.ts';
import type { PendingSubmissionSnapshot, PositionLifecycleState } from './state-types.ts';
import { classifyAction } from './action-semantics.ts';
import { hasAnyWalletEvidenceForPendingSubmission } from './pending-submission-wallet-evidence.ts';

export async function runPendingRecoveryGate(input: {
  pendingSubmissionStore: PendingSubmissionStore;
  pendingSubmission: PendingSubmissionSnapshot | null;
  confirmationProvider?: LiveConfirmationProvider;
  accountState?: LiveAccountState;
  currentLifecycleState: PositionLifecycleState;
  now?: Date;
}) {
  if (!input.pendingSubmission) {
    return {
      blocked: false as const,
      reason: 'clear' as const,
      lifecycleState: input.currentLifecycleState
    };
  }

  if (
    input.currentLifecycleState === 'open_pending' &&
    input.accountState &&
    !hasAnyWalletEvidenceForPendingSubmission(input.pendingSubmission, input.accountState) &&
    input.pendingSubmission.orderAction &&
    input.pendingSubmission.createdAt &&
    (input.now ?? new Date()).getTime() - Date.parse(input.pendingSubmission.createdAt) >= 5_000
  ) {
    await input.pendingSubmissionStore.clear();
    return {
      blocked: false as const,
      reason: 'pending-submission-failed' as const,
      lifecycleState: 'closed' as const
    };
  }

  const recovery = await recoverPendingSubmission({
    pendingSubmission: input.pendingSubmission,
    confirmationProvider: input.confirmationProvider,
    accountState: input.accountState,
    now: input.now
  });

  let lifecycleState = input.currentLifecycleState;

  if (recovery.clearPending) {
    await input.pendingSubmissionStore.clear();
    lifecycleState = resolveLifecycleAfterRecovery(
      lifecycleState,
      recovery.reason,
      input.pendingSubmission,
      input.accountState
    );
  } else if (recovery.nextPendingSubmission) {
    await input.pendingSubmissionStore.write(recovery.nextPendingSubmission);
  }

  return {
    blocked: recovery.blocked,
    reason: recovery.reason,
    lifecycleState
  };
}

export function runAccountReconciliationGate(accountState: LiveAccountState | undefined) {
  if (!accountState) {
    return null;
  }

  return reconcileLiveState(accountState);
}

function resolveLifecycleAfterRecovery(
  currentLifecycleState: PositionLifecycleState,
  reason: 'clear' | 'pending-submission-confirmed' | 'pending-submission-failed' | 'pending-submission-filled' | 'pending-submission-recovery-required' | 'pending-submission-timeout',
  pendingSubmission: PendingSubmissionSnapshot | null,
  accountState?: LiveAccountState
): PositionLifecycleState {
  if (reason === 'pending-submission-confirmed' || reason === 'pending-submission-filled') {
    if (
      currentLifecycleState === 'closed'
      && pendingSubmission?.orderAction
      && classifyAction(pendingSubmission.orderAction) === 'open_risk'
    ) {
      return 'open';
    }

    if (
      currentLifecycleState === 'closed' &&
      pendingSubmission &&
      hasAnyWalletEvidenceForPendingSubmission(pendingSubmission, accountState)
    ) {
      return 'open';
    }

    if (currentLifecycleState === 'open_pending') {
      return 'open';
    }

    if (currentLifecycleState === 'lp_exit_pending') {
      return 'inventory_exit_ready';
    }

    if (currentLifecycleState === 'inventory_exit_pending') {
      return 'closed';
    }
  }

  if (reason === 'pending-submission-failed') {
    if (currentLifecycleState === 'open_pending') {
      return 'closed';
    }

    if (currentLifecycleState === 'lp_exit_pending' || currentLifecycleState === 'inventory_exit_pending') {
      return 'open';
    }
  }

  return currentLifecycleState;
}
