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

  it('blocks when the single order limit is exceeded', () => {
    const result = evaluateLiveGuards({
      symbol: 'SAFE',
      whitelist: ['SAFE'],
      requestedPositionSol: 0.6,
      maxLivePositionSol: 1.0,
      killSwitchEngaged: false,
      requireWhitelist: true,
      sessionPhase: 'active',
      maxSingleOrderSol: 0.5
    });

    expect(result).toEqual({
      allowed: false,
      reason: 'single-order-limit-exceeded'
    });
  });

  it('blocks when the daily spend limit is exceeded', () => {
    const result = evaluateLiveGuards({
      symbol: 'SAFE',
      whitelist: ['SAFE'],
      requestedPositionSol: 0.3,
      maxLivePositionSol: 1.0,
      killSwitchEngaged: false,
      requireWhitelist: true,
      sessionPhase: 'active',
      maxDailySpendSol: 2.0,
      dailySpendSol: 1.8
    });

    expect(result).toEqual({
      allowed: false,
      reason: 'daily-spend-limit-exceeded'
    });
  });

  it('allows when spending limits are not configured', () => {
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
