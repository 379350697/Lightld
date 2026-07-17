import { describe, expect, it } from 'vitest';

import { applyRuntimeActionPolicy } from '../../../src/runtime/runtime-action-policy';
import { classifyAction } from '../../../src/runtime/action-semantics';

describe('action semantics', () => {
  it('classifies actions by exposure intent', () => {
    expect(classifyAction('deploy')).toBe('open_risk');
    expect(classifyAction('add-lp')).toBe('open_risk');
    expect(classifyAction('dca-out')).toBe('reduce_risk');
    expect(classifyAction('withdraw-lp')).toBe('reduce_risk');
    expect(classifyAction('claim-fee')).toBe('maintain_position');
    expect(classifyAction('rebalance-lp')).toBe('maintain_position');
    expect(classifyAction('hold')).toBe('no_op');
  });
});

describe('applyRuntimeActionPolicy', () => {
  it('keeps exits available in paused mode while blocking new exposure', () => {
    expect(applyRuntimeActionPolicy({ mode: 'paused', action: 'withdraw-lp' })).toEqual({
      action: 'withdraw-lp',
      blockedReason: ''
    });
    expect(applyRuntimeActionPolicy({ mode: 'paused', action: 'add-lp' })).toEqual({
      action: 'hold',
      blockedReason: 'runtime-paused'
    });
  });

  it('blocks exposure-increasing actions while allowing exits in circuit_open mode', () => {
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

    expect(
      applyRuntimeActionPolicy({
        mode: 'circuit_open',
        action: 'add-lp'
      })
    ).toEqual({
      action: 'hold',
      blockedReason: 'runtime-circuit-open'
    });

    expect(
      applyRuntimeActionPolicy({
        mode: 'circuit_open',
        action: 'claim-fee'
      })
    ).toEqual({
      action: 'hold',
      blockedReason: 'runtime-circuit-open'
    });
  });

  it('allows only full exits in recovering mode', () => {
    expect(
      applyRuntimeActionPolicy({
        mode: 'recovering',
        action: 'withdraw-lp'
      })
    ).toEqual({
      action: 'withdraw-lp',
      blockedReason: ''
    });

    expect(
      applyRuntimeActionPolicy({
        mode: 'recovering',
        action: 'rebalance-lp'
      })
    ).toEqual({
      action: 'hold',
      blockedReason: 'runtime-recovering'
    });
  });

  it('allows exits while blocking LP opens and maintenance in flatten_only mode', () => {
    expect(
      applyRuntimeActionPolicy({
        mode: 'flatten_only',
        action: 'withdraw-lp'
      })
    ).toEqual({
      action: 'withdraw-lp',
      blockedReason: ''
    });

    expect(
      applyRuntimeActionPolicy({
        mode: 'flatten_only',
        action: 'add-lp'
      })
    ).toEqual({
      action: 'hold',
      blockedReason: 'runtime-flatten-only'
    });

    expect(
      applyRuntimeActionPolicy({
        mode: 'flatten_only',
        action: 'claim-fee'
      })
    ).toEqual({
      action: 'hold',
      blockedReason: 'runtime-flatten-only'
    });

    expect(
      applyRuntimeActionPolicy({
        mode: 'flatten_only',
        action: 'rebalance-lp'
      })
    ).toEqual({
      action: 'hold',
      blockedReason: 'runtime-flatten-only'
    });
  });
});
