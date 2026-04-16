import { describe, expect, it } from 'vitest';

import {
  buildPendingTimeoutAt,
  isFullPositionExitAction,
  isResolvedConfirmation,
  resolveNextLifecycleState,
  resolveOrderIntentSide
} from '../../../src/runtime/live-cycle-state';

describe('live-cycle-state helpers', () => {
  it('maps runtime actions to order intent sides', () => {
    expect(resolveOrderIntentSide('deploy')).toBe('buy');
    expect(resolveOrderIntentSide('dca-out')).toBe('sell');
    expect(resolveOrderIntentSide('add-lp')).toBe('add-lp');
  });

  it('marks only full exit actions as full position exits', () => {
    expect(isFullPositionExitAction('withdraw-lp')).toBe(true);
    expect(isFullPositionExitAction('dca-out')).toBe(true);
    expect(isFullPositionExitAction('add-lp')).toBe(false);
  });

  it('resolves lifecycle transitions after submission', () => {
    expect(resolveNextLifecycleState('open', 'withdraw-lp', true, false)).toBe('lp_exit_pending');
    expect(resolveNextLifecycleState('open', 'withdraw-lp', true, true)).toBe('inventory_exit_ready');
    expect(resolveNextLifecycleState('inventory_exit_ready', 'dca-out', true, true)).toBe('closed');
    expect(resolveNextLifecycleState('closed', 'add-lp', true, false)).toBe('open_pending');
    expect(resolveNextLifecycleState('closed', 'add-lp', true, true)).toBe('open');
    expect(resolveNextLifecycleState('closed', 'hold', false, false)).toBe('closed');
  });

  it('derives confirmation resolution and pending timeout deterministically', () => {
    expect(isResolvedConfirmation('confirmed', 'finalized')).toBe(true);
    expect(isResolvedConfirmation('submitted', 'processed')).toBe(false);
    expect(buildPendingTimeoutAt('2026-03-22T00:00:00.000Z')).toBe('2026-03-22T00:02:00.000Z');
  });
});
