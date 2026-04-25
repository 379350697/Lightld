import type { ConfirmationStatus } from '../execution/confirmation-tracker.ts';
import type { PendingFinality } from './state-types.ts';
import type { PendingRecoveryReason } from './live-cycle-preflight.ts';

export type ExecutionLifecycleStatus = 'confirmed' | 'unresolved' | 'missing-chain' | 'missing-local';

export function toExecutionLifecycleStatus(input: {
  recoveryReason?: PendingRecoveryReason;
  broadcastStatus?: string;
  confirmationStatus?: ConfirmationStatus | string;
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

  if (input.historyStatus === 'missing-chain') {
    return 'missing-chain' as const;
  }

  if (input.historyStatus === 'missing-close' || input.historyStatus === 'failed' || input.historyStatus === 'unresolved') {
    return 'unresolved' as const;
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
