import { describe, expect, it } from 'vitest';

import { resolveFillMirrorSide } from '../../../src/runtime/live-cycle-outcomes';

describe('resolveFillMirrorSide', () => {
  it('preserves LP and fee actions for mirrored fills', () => {
    expect(resolveFillMirrorSide('add-lp')).toBe('add-lp');
    expect(resolveFillMirrorSide('withdraw-lp')).toBe('withdraw-lp');
    expect(resolveFillMirrorSide('claim-fee')).toBe('claim-fee');
    expect(resolveFillMirrorSide('rebalance-lp')).toBe('rebalance-lp');
  });

  it('keeps swap actions mapped to buy and sell', () => {
    expect(resolveFillMirrorSide('deploy')).toBe('buy');
    expect(resolveFillMirrorSide('dca-out')).toBe('sell');
  });
});
