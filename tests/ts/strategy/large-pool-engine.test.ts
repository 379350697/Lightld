import { describe, expect, it } from 'vitest';

import { buildLargePoolDecision } from '../../../src/strategy/engines/large-pool-engine';

describe('buildLargePoolDecision', () => {
  it('returns deploy when the score exceeds the threshold', () => {
    expect(
      buildLargePoolDecision(
        {
          score: 80
        },
        {
          minScore: 70
        }
      )
    ).toEqual({
      action: 'deploy',
      reason: 'criteria-met'
    });
  });

  it('returns hold when the score is below the threshold', () => {
    expect(
      buildLargePoolDecision(
        {
          score: 65
        },
        {
          minScore: 70
        }
      )
    ).toEqual({
      action: 'hold',
      reason: 'score-below-minimum'
    });
  });
});
