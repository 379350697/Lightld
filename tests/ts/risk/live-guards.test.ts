import { describe, expect, it } from 'vitest';

import { evaluateLiveGuards } from '../../../src/risk/live-guards';

describe('evaluateLiveGuards', () => {
  it('blocks when the kill switch is engaged', () => {
    const result = evaluateLiveGuards({
      action: 'deploy',
      symbol: 'SAFE',
      requestedPositionSol: 0.1,
      maxLivePositionSol: 0.25,
      killSwitchEngaged: true,
      sessionPhase: 'active'
    });

    expect(result).toEqual({
      allowed: false,
      reason: 'kill-switch-engaged'
    });
  });

  it('does not depend on whitelist membership for exits', () => {
    const result = evaluateLiveGuards({
      action: 'withdraw-lp',
      symbol: 'TOKEN',
      requestedPositionSol: 0.1,
      maxLivePositionSol: 0.25,
      killSwitchEngaged: false,
      sessionPhase: 'closed'
    });

    expect(result).toEqual({
      allowed: true,
      reason: 'allowed'
    });
  });

  it('allows an opening action within cap and without whitelist dependency', () => {
    const result = evaluateLiveGuards({
      action: 'add-lp',
      symbol: 'SAFE',
      requestedPositionSol: 0.1,
      maxLivePositionSol: 0.25,
      killSwitchEngaged: false,
      sessionPhase: 'active'
    });

    expect(result).toEqual({
      allowed: true,
      reason: 'allowed'
    });
  });

  it('blocks when the single order limit is exceeded', () => {
    const result = evaluateLiveGuards({
      action: 'add-lp',
      symbol: 'SAFE',
      requestedPositionSol: 0.6,
      maxLivePositionSol: 1.0,
      killSwitchEngaged: false,
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
      action: 'add-lp',
      symbol: 'SAFE',
      requestedPositionSol: 0.3,
      maxLivePositionSol: 1.0,
      killSwitchEngaged: false,
      sessionPhase: 'active',
      maxDailySpendSol: 2.0,
      dailySpendSol: 1.8
    });

    expect(result).toEqual({
      allowed: false,
      reason: 'daily-spend-limit-exceeded'
    });
  });

  it('allows exits even when daily spend would otherwise be exhausted', () => {
    const result = evaluateLiveGuards({
      action: 'withdraw-lp',
      symbol: 'SAFE',
      requestedPositionSol: 0.3,
      maxLivePositionSol: 0.25,
      killSwitchEngaged: false,
      sessionPhase: 'closed',
      maxDailySpendSol: 2.0,
      dailySpendSol: 1.9
    });

    expect(result).toEqual({
      allowed: true,
      reason: 'allowed'
    });
  });
});
