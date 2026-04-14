import type { ConfirmationFinality } from '../execution/live-confirmation-provider.ts';
import { buildOrderIntent } from '../execution/order-intent-builder.ts';
import type { ConfirmationStatus } from '../execution/confirmation-tracker.ts';
import type { LiveAction } from './action-semantics.ts';
import type { PositionLifecycleState } from './state-types.ts';

const PENDING_SUBMISSION_TIMEOUT_MS = 2 * 60_000;

type OrderIntentSide = Parameters<typeof buildOrderIntent>[0]['side'];

export function buildPendingTimeoutAt(startedAt: string) {
  return new Date(Date.parse(startedAt) + PENDING_SUBMISSION_TIMEOUT_MS).toISOString();
}

export function isResolvedConfirmation(
  status: ConfirmationStatus,
  finality?: ConfirmationFinality
) {
  if (status === 'failed') {
    return true;
  }

  return status === 'confirmed' && (finality === 'confirmed' || finality === 'finalized');
}

export function resolveOrderIntentSide(action: LiveAction): OrderIntentSide {
  if (action === 'deploy') {
    return 'buy';
  }

  if (action === 'dca-out' || action === 'hold') {
    return 'sell';
  }

  return action;
}

export function isFullPositionExitAction(action: LiveAction) {
  return action === 'dca-out' || action === 'withdraw-lp';
}

export function resolveNextLifecycleState(
  currentLifecycleState: PositionLifecycleState,
  action: LiveAction,
  liveOrderSubmitted: boolean,
  synchronouslyResolved = false
): PositionLifecycleState {
  if (!liveOrderSubmitted) {
    return currentLifecycleState;
  }

  if (action === 'withdraw-lp') {
    return synchronouslyResolved ? 'inventory_exit_ready' : 'lp_exit_pending';
  }

  if (action === 'dca-out') {
    return synchronouslyResolved ? 'closed' : 'inventory_exit_pending';
  }

  if (action === 'deploy' || action === 'add-lp') {
    return 'open';
  }

  return currentLifecycleState;
}
