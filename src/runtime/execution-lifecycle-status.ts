import type { ConfirmationStatus } from '../execution/confirmation-tracker.ts';
import type { PendingFinality } from './state-types.ts';
import type { PendingRecoveryReason } from './live-cycle-preflight.ts';
import { isFullExitAction, LIVE_ACTIONS, type LiveAction } from './action-semantics.ts';

export type ExecutionLifecycleStatus = 'confirmed' | 'unresolved' | 'missing-chain' | 'missing-local' | 'local-intent';

function hasText(value: string | undefined) {
  return Boolean(value && value.length > 0);
}

function toLiveAction(action: string | undefined): LiveAction | undefined {
  return LIVE_ACTIONS.includes(action as LiveAction) ? action as LiveAction : undefined;
}

function isLocalIntentEligibleAction(action: string | undefined) {
  const liveAction = toLiveAction(action);
  return Boolean(liveAction) && liveAction !== 'hold';
}

function isFullExitIntentAction(action: string | undefined) {
  const liveAction = toLiveAction(action);
  return liveAction ? isFullExitAction(liveAction) : false;
}

export function isLocalIntentOnlyOrder(input: {
  action?: string;
  broadcastStatus?: string;
  confirmationStatus?: string;
  submissionId?: string;
  confirmationSignature?: string;
}) {
  if (!isLocalIntentEligibleAction(input.action)) {
    return false;
  }

  if (hasText(input.submissionId) || hasText(input.confirmationSignature)) {
    return false;
  }

  if (input.broadcastStatus === 'not_submitted') {
    return true;
  }

  return (
    (input.broadcastStatus === undefined || input.broadcastStatus === '' || input.broadcastStatus === 'pending')
    && (input.confirmationStatus === undefined || input.confirmationStatus === '' || input.confirmationStatus === 'unknown')
  );
}

export function isLocalFullExitIntentOnlyOrder(input: {
  action?: string;
  broadcastStatus?: string;
  confirmationStatus?: string;
  submissionId?: string;
  confirmationSignature?: string;
}) {
  return isFullExitIntentAction(input.action) && isLocalIntentOnlyOrder(input);
}

export function toExecutionLifecycleStatus(input: {
  recoveryReason?: PendingRecoveryReason;
  action?: string;
  broadcastStatus?: string;
  confirmationStatus?: ConfirmationStatus | string;
  submissionId?: string;
  confirmationSignature?: string;
  historyStatus?: ExecutionLifecycleStatus | 'ok' | 'missing-close' | 'failed';
  finality?: PendingFinality | 'unknown';
}) {
  if (input.recoveryReason === 'pending-submission-confirmed' || input.recoveryReason === 'pending-submission-filled') {
    return 'confirmed' as const;
  }

  if (input.recoveryReason === 'pending-submission-failed' || input.recoveryReason === 'pending-submission-timeout') {
    return 'unresolved' as const;
  }

  if (input.historyStatus === 'ok') {
    return 'confirmed' as const;
  }

  if (input.historyStatus === 'missing-local') {
    return 'missing-local' as const;
  }

  if (input.historyStatus === 'local-intent') {
    return 'local-intent' as const;
  }

  if (input.historyStatus === 'missing-chain') {
    return 'missing-chain' as const;
  }

  if (input.historyStatus === 'missing-close' || input.historyStatus === 'failed' || input.historyStatus === 'unresolved') {
    return 'unresolved' as const;
  }

  if (isLocalIntentOnlyOrder(input)) {
    return 'local-intent' as const;
  }

  if (
    input.broadcastStatus === 'unknown'
    || input.broadcastStatus === 'failed'
    || input.confirmationStatus === 'submitted'
    || input.confirmationStatus === 'unknown'
    || input.confirmationStatus === 'failed'
    || input.finality === 'unknown'
  ) {
    return 'unresolved' as const;
  }

  return 'confirmed' as const;
}
