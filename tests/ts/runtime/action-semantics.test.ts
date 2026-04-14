import { describe, expect, it } from 'vitest';

import {
  classifyAction,
  isExposureIncreasingAction,
  isExposureReducingAction
} from '../../../src/runtime/action-semantics';

describe('action semantics helpers', () => {
  it('marks only opening actions as exposure increasing', () => {
    expect(isExposureIncreasingAction('deploy')).toBe(true);
    expect(isExposureIncreasingAction('add-lp')).toBe(true);
    expect(isExposureIncreasingAction('withdraw-lp')).toBe(false);
    expect(isExposureIncreasingAction('claim-fee')).toBe(false);
  });

  it('marks only exit actions as exposure reducing', () => {
    expect(isExposureReducingAction('dca-out')).toBe(true);
    expect(isExposureReducingAction('withdraw-lp')).toBe(true);
    expect(isExposureReducingAction('deploy')).toBe(false);
    expect(isExposureReducingAction('rebalance-lp')).toBe(false);
  });

  it('keeps maintenance and no-op actions distinct', () => {
    expect(classifyAction('claim-fee')).toBe('maintain_position');
    expect(classifyAction('rebalance-lp')).toBe('maintain_position');
    expect(classifyAction('hold')).toBe('no_op');
  });
});
