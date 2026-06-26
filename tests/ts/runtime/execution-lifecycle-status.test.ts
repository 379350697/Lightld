import { describe, expect, it } from 'vitest';

import {
  isLocalFullExitIntentOnlyOrder,
  isLocalIntentOnlyOrder,
  toExecutionLifecycleStatus
} from '../../../src/runtime/execution-lifecycle-status';

describe('execution lifecycle status', () => {
  it('treats all locally unsubmitted live actions as local intents', () => {
    expect(isLocalIntentOnlyOrder({
      action: 'withdraw-lp',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe(true);

    expect(isLocalIntentOnlyOrder({
      action: 'dca-out',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe(true);

    expect(isLocalIntentOnlyOrder({
      action: 'claim-fee',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe(true);

    expect(isLocalIntentOnlyOrder({
      action: 'rebalance-lp',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe(true);
  });

  it('keeps a separate full-exit-only local intent helper', () => {
    expect(isLocalFullExitIntentOnlyOrder({
      action: 'withdraw-lp',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe(true);

    expect(isLocalFullExitIntentOnlyOrder({
      action: 'claim-fee',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe(false);
  });

  it('reports maintenance local intents without classifying them as full exits', () => {
    expect(toExecutionLifecycleStatus({
      action: 'claim-fee',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe('local-intent');
  });

  it('does not treat hold as a local intent', () => {
    expect(isLocalIntentOnlyOrder({
      action: 'hold',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe(false);

    expect(toExecutionLifecycleStatus({
      action: 'hold',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).not.toBe('local-intent');
  });

  it('does not treat unknown actions as local intents', () => {
    expect(isLocalIntentOnlyOrder({
      action: 'unknown',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe(false);

    expect(isLocalIntentOnlyOrder({
      action: '',
      broadcastStatus: 'pending',
      confirmationStatus: 'unknown'
    })).toBe(false);
  });
});
