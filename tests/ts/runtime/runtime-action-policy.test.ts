import { describe, expect, it } from 'vitest';

import { applyRuntimeActionPolicy } from '../../../src/runtime/runtime-action-policy';

describe('applyRuntimeActionPolicy', () => {
  it('blocks deploy while allowing dca-out in circuit_open mode', () => {
    expect(
      applyRuntimeActionPolicy({
        mode: 'circuit_open',
        action: 'deploy'
      })
    ).toEqual({
      action: 'hold',
      blockedReason: 'runtime-circuit-open'
    });

    expect(
      applyRuntimeActionPolicy({
        mode: 'circuit_open',
        action: 'dca-out'
      })
    ).toEqual({
      action: 'dca-out',
      blockedReason: ''
    });
  });
});
