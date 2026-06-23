import type { PendingRecoveryReason } from './live-cycle-preflight.ts';
import { isLocalIntentOnlyOrder } from './execution-lifecycle-status.ts';

export type ExecutionTerminalStatus =
  | 'confirmed'
  | 'failed'
  | 'not-submitted'
  | 'unknown_pending_reconciliation'
  | 'manual-review';

export function toExecutionTerminalStatus(input: {
  recoveryReason?: PendingRecoveryReason;
  action?: string;
  broadcastStatus?: string;
  confirmationStatus?: string;
  submissionId?: string;
  confirmationSignature?: string;
  finality?: string;
}) {
  if (input.recoveryReason === 'pending-submission-confirmed' || input.recoveryReason === 'pending-submission-filled') {
    return 'confirmed' as const;
  }

  if (input.recoveryReason === 'pending-submission-failed') {
    return 'failed' as const;
  }

  if (input.recoveryReason === 'pending-submission-recovery-required') {
    return 'manual-review' as const;
  }

  if (input.recoveryReason === 'pending-submission-timeout') {
    return 'unknown_pending_reconciliation' as const;
  }

  if (isLocalIntentOnlyOrder(input)) {
    return 'not-submitted' as const;
  }

  if (input.broadcastStatus === 'failed' || input.confirmationStatus === 'failed' || input.finality === 'failed') {
    return 'failed' as const;
  }

  if (input.broadcastStatus === 'unknown') {
    return 'unknown_pending_reconciliation' as const;
  }

  if (input.confirmationStatus === 'submitted' || input.confirmationStatus === 'unknown' || input.finality === 'unknown') {
    return 'unknown_pending_reconciliation' as const;
  }

  return 'confirmed' as const;
}
