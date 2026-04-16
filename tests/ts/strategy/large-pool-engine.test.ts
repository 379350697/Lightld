import { describe, expect, it } from 'vitest';

import { buildLargePoolDecision } from '../../../src/strategy/engines/large-pool-engine';

describe('buildLargePoolDecision', () => {
  it('returns deploy whenever the hard gates passed and the pool reaches the engine', () => {
    expect(buildLargePoolDecision()).toEqual({
      action: 'deploy',
      reason: 'criteria-met'
    });
  });
});
