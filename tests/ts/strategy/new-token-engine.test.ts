import { describe, expect, it } from 'vitest';

import { buildNewTokenDecision } from '../../../src/strategy/engines/new-token-engine';

describe('buildNewTokenDecision', () => {
  it('returns dca-out when the trader is in session and has inventory', () => {
    expect(
      buildNewTokenDecision({
        inSession: true,
        hasInventory: true
      })
    ).toEqual({
      action: 'dca-out'
    });
  });

  it('returns hold when the trader lacks inventory', () => {
    expect(
      buildNewTokenDecision({
        inSession: true,
        hasInventory: false
      })
    ).toEqual({
      action: 'hold'
    });
  });
});
