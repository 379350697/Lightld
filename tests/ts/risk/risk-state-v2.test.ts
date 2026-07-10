import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CANARY_RISK_LIMITS,
  approveRiskRecovery,
  applyRiskObservation,
  createInitialRiskStateV2,
  evaluateRiskIncrease
} from '../../../src/risk/risk-policy-v2';
import { RiskStateV2Store } from '../../../src/risk/risk-state-v2';

const NOW = '2026-07-10T02:00:00.000Z';

describe('RiskStateV2 policy', () => {
  it('publishes the locked canary defaults', () => {
    expect(CANARY_RISK_LIMITS).toMatchObject({
      maxPositionSol: 0.01,
      maxActivePositions: 1,
      maxDailyNewRiskSol: 0.05,
      maxDailyLossSol: 0.02,
      maxDrawdownPct: 1,
      warningFraction: 0.8,
      minimumSolReserveSol: 0.05
    });
  });

  it('enters a latched warning at 80% daily-loss utilization', () => {
    const initial = createInitialRiskStateV2({
      now: NOW,
      startOfDayEquitySol: 10,
      currentEquitySol: 10,
      availableSol: 10
    });
    const state = applyRiskObservation(initial, {
      now: '2026-07-10T02:01:00.000Z',
      currentEquitySol: 9.984,
      realizedPnlSol: -0.016,
      unrealizedPnlSol: 0,
      availableSol: 9.984
    }, CANARY_RISK_LIMITS);

    expect(state.riskMode).toBe('warning');
    expect(state.allowNewOpens).toBe(false);
    expect(state.flattenOnly).toBe(false);
    expect(state.manualRecoveryRequired).toBe(true);
    expect(state.triggerReasons).toContain('daily-loss-warning');
    expect(() => approveRiskRecovery(state, {
      approvedBy: 'operator',
      approvedAt: '2026-07-10T02:01:30.000Z'
    }, CANARY_RISK_LIMITS)).toThrow(/unsafe/i);
  });

  it('enters flatten-only on the hard daily loss or HWM drawdown limit', () => {
    const initial = createInitialRiskStateV2({
      now: NOW,
      startOfDayEquitySol: 1,
      currentEquitySol: 1,
      availableSol: 1
    });
    const dailyLoss = applyRiskObservation(initial, {
      now: '2026-07-10T02:01:00.000Z',
      currentEquitySol: 0.98,
      realizedPnlSol: -0.02,
      unrealizedPnlSol: 0,
      availableSol: 0.98
    }, CANARY_RISK_LIMITS);
    const drawdown = applyRiskObservation(initial, {
      now: '2026-07-10T02:01:00.000Z',
      currentEquitySol: 0.989,
      realizedPnlSol: -0.011,
      unrealizedPnlSol: 0,
      availableSol: 0.989
    }, CANARY_RISK_LIMITS);

    expect(dailyLoss).toMatchObject({ riskMode: 'flatten_only', flattenOnly: true });
    expect(dailyLoss.triggerReasons).toContain('daily-loss-limit');
    expect(drawdown).toMatchObject({ riskMode: 'flatten_only', flattenOnly: true });
    expect(drawdown.triggerReasons).toContain('drawdown-limit');
  });

  it.each([
    ['dataQualityStatus', 'degraded', 'data-quality-untrusted'],
    ['reconciliationStatus', 'mismatch', 'reconciliation-untrusted'],
    ['outboxStatus', 'unknown', 'outbox-untrusted']
  ] as const)('fails closed without blind flatten when %s is %s', (field, value, reason) => {
    const initial = createInitialRiskStateV2({
      now: NOW,
      startOfDayEquitySol: 1,
      currentEquitySol: 1,
      availableSol: 1
    });
    const state = applyRiskObservation(initial, {
      now: '2026-07-10T02:01:00.000Z',
      currentEquitySol: 1,
      realizedPnlSol: 0,
      unrealizedPnlSol: 0,
      availableSol: 1,
      [field]: value
    }, CANARY_RISK_LIMITS);

    expect(state).toMatchObject({
      riskMode: 'reconcile_required',
      allowNewOpens: false,
      flattenOnly: false,
      manualRecoveryRequired: true
    });
    expect(state.triggerReasons).toContain(reason);
  });

  it('does not auto-clear a risk latch and requires explicit safe recovery approval', () => {
    const initial = createInitialRiskStateV2({
      now: NOW,
      startOfDayEquitySol: 1,
      currentEquitySol: 1,
      availableSol: 1
    });
    const blocked = applyRiskObservation(initial, {
      now: '2026-07-10T02:01:00.000Z',
      currentEquitySol: 1,
      realizedPnlSol: 0,
      unrealizedPnlSol: 0,
      availableSol: 1,
      reconciliationStatus: 'mismatch'
    }, CANARY_RISK_LIMITS);
    const healthyObservation = applyRiskObservation(blocked, {
      now: '2026-07-10T02:02:00.000Z',
      currentEquitySol: 1,
      realizedPnlSol: 0,
      unrealizedPnlSol: 0,
      availableSol: 1,
      reconciliationStatus: 'matched'
    }, CANARY_RISK_LIMITS);

    expect(healthyObservation.riskMode).toBe('manual_hold');
    expect(healthyObservation.allowNewOpens).toBe(false);
    expect(() => approveRiskRecovery(blocked, {
      approvedBy: 'operator',
      approvedAt: '2026-07-10T02:01:30.000Z'
    }, CANARY_RISK_LIMITS)).toThrow(/unsafe/i);
    expect(approveRiskRecovery(healthyObservation, {
      approvedBy: 'operator',
      approvedAt: '2026-07-10T02:02:30.000Z'
    }, CANARY_RISK_LIMITS)).toMatchObject({
      riskMode: 'healthy',
      allowNewOpens: true,
      manualRecoveryRequired: false,
      recoveryApprovedBy: 'operator'
    });
  });

  it('enforces position, active-count, daily-new-risk, and SOL-reserve limits', () => {
    const state = createInitialRiskStateV2({
      now: NOW,
      startOfDayEquitySol: 1,
      currentEquitySol: 1,
      availableSol: 0.06
    });

    expect(evaluateRiskIncrease(state, { amountSol: 0.011 }, CANARY_RISK_LIMITS).allowed).toBe(false);
    expect(evaluateRiskIncrease({ ...state, activePositionCount: 1 }, { amountSol: 0.01 }, CANARY_RISK_LIMITS).allowed).toBe(false);
    expect(evaluateRiskIncrease({ ...state, dailyNewRiskSol: 0.045 }, { amountSol: 0.01 }, CANARY_RISK_LIMITS).allowed).toBe(false);
    expect(evaluateRiskIncrease(state, { amountSol: 0.02 }, {
      ...CANARY_RISK_LIMITS,
      maxPositionSol: 1
    }).reason).toBe('insufficient-sol-reserve');
  });
});

describe('RiskStateV2Store', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('persists and reloads a validated risk snapshot atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-risk-state-v2-'));
    directories.push(root);
    const store = new RiskStateV2Store(root);
    const state = createInitialRiskStateV2({
      now: NOW,
      startOfDayEquitySol: 1,
      currentEquitySol: 1,
      availableSol: 0.5
    });

    await store.write(state);

    await expect(store.read()).resolves.toEqual(state);
  });
});
