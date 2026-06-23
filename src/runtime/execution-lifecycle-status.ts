import type { ConfirmationStatus } from '../execution/confirmation-tracker.ts';
import type { PendingFinality } from './state-types.ts';
import type { PendingRecoveryReason } from './live-cycle-preflight.ts';

export type ExecutionLifecycleStatus = 'confirmed' | 'unresolved' | 'missing-chain' | 'missing-local' | 'local-intent';

function hasText(value: string | undefined) {
  return Boolean(value && value.length > 0);
}

function isExitIntentAction(action: string | undefined) {
  return action === 'withdraw-lp' || action === 'dca-out' || action === 'claim-fee' || action === 'rebalance-lp';
}

export function isLocalIntentOnlyOrder(input: {
  action?: string;
  broadcastStatus?: string;
  confirmationStatus?: string;
  submissionId?: string;
  confirmationSignature?: string;
}) {
  if (!isExitIntentAction(input.action)) {
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
