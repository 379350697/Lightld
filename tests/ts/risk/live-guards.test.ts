import { describe, expect, it } from 'vitest';

import { evaluateLiveGuards } from '../../../src/risk/live-guards';

describe('evaluateLiveGuards', () => {
  it('blocks when the kill switch is engaged', () => {
    const result = evaluateLiveGuards({
      symbol: 'SAFE',
      whitelist: ['SAFE'],
      requestedPositionSol: 0.1,
      maxLivePositionSol: 0.25,
      killSwitchEngaged: true,
      requireWhitelist: true,
      sessionPhase: 'active'
    });

    expect(result).toEqual({
      allowed: false,
      reason: 'kill-switch-engaged'
    });
  });

  it('blocks when the token is not whitelisted', () => {
    const result = evaluateLiveGuards({
      symbol: 'TOKEN',
      whitelist: ['SAFE'],
      requestedPositionSol: 0.1,
      maxLivePositionSol: 0.25,
      killSwitchEngaged: false,
      requireWhitelist: true,
      sessionPhase: 'active'
    });

    expect(result).toEqual({
      allowed: false,
      reason: 'token-not-whitelisted'
    });
  });

  it('allows a whitelisted position within the cap', () => {
    const result = evaluateLiveGuards({
      symbol: 'SAFE',
      whitelist: ['SAFE'],
      requestedPositionSol: 0.1,
      maxLivePositionSol: 0.25,
      killSwitchEngaged: false,
      requireWhitelist: true,
      sessionPhase: 'active'
    });

    expect(result).toEqual({
      allowed: true,
      reason: 'allowed'
    });
  });
});
