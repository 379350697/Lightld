import { describe, expect, it } from 'vitest';

import {
  classifyAction,
  isExposureIncreasingAction,
  isExposureReducingAction,
  isFullExitAction,
  isLpMaintenanceAction,
  isOpenRiskAction,
  isRiskReducingAction
} from '../../../src/runtime/action-semantics';

describe('action semantics helpers', () => {
  it('marks only opening actions as exposure increasing', () => {
    expect(isOpenRiskAction('deploy')).toBe(true);
    expect(isOpenRiskAction('add-lp')).toBe(true);
    expect(isOpenRiskAction('withdraw-lp')).toBe(false);
    expect(isExposureIncreasingAction('deploy')).toBe(true);
    expect(isExposureIncreasingAction('add-lp')).toBe(true);
    expect(isExposureIncreasingAction('withdraw-lp')).toBe(false);
    expect(isExposureIncreasingAction('claim-fee')).toBe(false);
  });

  it('marks only exit actions as exposure reducing', () => {
    expect(isFullExitAction('dca-out')).toBe(true);
    expect(isFullExitAction('withdraw-lp')).toBe(true);
    expect(isFullExitAction('claim-fee')).toBe(false);
    expect(isRiskReducingAction('dca-out')).toBe(true);
    expect(isRiskReducingAction('withdraw-lp')).toBe(true);
    expect(isExposureReducingAction('dca-out')).toBe(true);
    expect(isExposureReducingAction('withdraw-lp')).toBe(true);
    expect(isExposureReducingAction('deploy')).toBe(false);
    expect(isExposureReducingAction('rebalance-lp')).toBe(false);
  });

  it('keeps maintenance and no-op actions distinct', () => {
    expect(isLpMaintenanceAction('claim-fee')).toBe(true);
    expect(isLpMaintenanceAction('rebalance-lp')).toBe(true);
    expect(isLpMaintenanceAction('withdraw-lp')).toBe(false);
    expect(classifyAction('claim-fee')).toBe('maintain_position');
    expect(classifyAction('rebalance-lp')).toBe('maintain_position');
    expect(classifyAction('hold')).toBe('no_op');
  });
});
