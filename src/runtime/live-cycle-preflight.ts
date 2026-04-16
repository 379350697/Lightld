import type { LiveConfirmationProvider } from '../execution/live-confirmation-provider.ts';
import type { LiveAccountState } from './live-account-provider.ts';
import { recoverPendingSubmission } from './pending-submission-recovery.ts';
import { PendingSubmissionStore } from './pending-submission-store.ts';
import { reconcileLiveState } from './reconcile-live-state.ts';
import type { PendingSubmissionSnapshot, PositionLifecycleState } from './state-types.ts';
import { classifyAction } from './action-semantics.ts';

export async function runPendingRecoveryGate(input: {
  pendingSubmissionStore: PendingSubmissionStore;
  pendingSubmission: PendingSubmissionSnapshot | null;
  confirmationProvider?: LiveConfirmationProvider;
  accountState?: LiveAccountState;
  currentLifecycleState: PositionLifecycleState;
}) {
  if (!input.pendingSubmission) {
    return {
      blocked: false as const,
      reason: 'clear' as const,
      lifecycleState: input.currentLifecycleState
    };
  }

  const recovery = await recoverPendingSubmission({
    pendingSubmission: input.pendingSubmission,
    confirmationProvider: input.confirmationProvider,
    accountState: input.accountState
  });

  let lifecycleState = input.currentLifecycleState;

  if (recovery.clearPending) {
    await input.pendingSubmissionStore.clear();
    lifecycleState = resolveLifecycleAfterRecovery(lifecycleState, recovery.reason, input.pendingSubmission);
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
  pendingSubmission: PendingSubmissionSnapshot | null
): PositionLifecycleState {
  if (reason === 'pending-submission-confirmed' || reason === 'pending-submission-filled') {
    if (
      currentLifecycleState === 'closed'
      && pendingSubmission?.orderAction
      && classifyAction(pendingSubmission.orderAction) === 'open_risk'
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
