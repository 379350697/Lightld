import { describe, expect, it } from 'vitest';

import { buildCashflowMetrics, buildEquityMetrics } from '../../../src/dashboard/dashboard-metrics';

describe('buildCashflowMetrics', () => {
  it('aggregates realized cashflow from fills by total, month, and day', () => {
    const result = buildCashflowMetrics({
      fills: [
        { side: 'add-lp', filledSol: 1, recordedAt: '2026-04-17T08:00:00.000Z' },
        { side: 'claim-fee', filledSol: 0.2, recordedAt: '2026-04-17T10:00:00.000Z' },
        { side: 'withdraw-lp', filledSol: 1.4, recordedAt: '2026-04-18T09:00:00.000Z' }
      ],
      now: new Date('2026-04-18T12:00:00.000Z')
    });

    expect(result.metricType).toBe('realized_cashflow');
    expect(result.totalCashflowSol).toBeCloseTo(0.6);
    expect(result.todayCashflowSol).toBeCloseTo(1.4);
    expect(result.monthCashflowSol).toBeCloseTo(0.6);
    expect(result.dailyCashflow).toEqual([
      { date: '2026-04-17', cashflowSol: -0.8 },
      { date: '2026-04-18', cashflowSol: 1.4 }
    ]);
  });

  it('falls back to order open cashflow when fills are unavailable', () => {
    const result = buildCashflowMetrics({
      fills: [],
      orderFallback: [
        { action: 'add-lp', requestedPositionSol: 0.1, updatedAt: '2026-04-18T02:00:00.000Z', createdAt: '2026-04-18T01:59:00.000Z' },
        { action: 'add-lp', requestedPositionSol: 0.2, updatedAt: '2026-04-17T02:00:00.000Z', createdAt: '2026-04-17T01:59:00.000Z' }
      ],
      now: new Date('2026-04-18T12:00:00.000Z')
    });

    expect(result.totalCashflowSol).toBeCloseTo(-0.3);
    expect(result.todayCashflowSol).toBeCloseTo(-0.1);
    expect(result.monthCashflowSol).toBeCloseTo(-0.3);
    expect(result.dailyCashflow).toEqual([
      { date: '2026-04-17', cashflowSol: -0.2 },
      { date: '2026-04-18', cashflowSol: -0.1 }
    ]);
  });

  it('keeps the latest net worth snapshot for each day', () => {
    const result = buildEquityMetrics({
      snapshots: [
        {
          snapshotAt: '2026-04-17T08:00:00.000Z',
          walletSol: 1.1,
          lpValueSol: 0.7,
          unclaimedFeeSol: 0.03,
          netWorthSol: 1.83,
          openPositionCount: 1
        },
        {
          snapshotAt: '2026-04-17T20:00:00.000Z',
          walletSol: 1.05,
          lpValueSol: 0.82,
          unclaimedFeeSol: 0.04,
          netWorthSol: 1.91,
          openPositionCount: 1
        },
        {
          snapshotAt: '2026-04-18T09:00:00.000Z',
          walletSol: 1.2,
          lpValueSol: 0.75,
          unclaimedFeeSol: 0.05,
          netWorthSol: 2,
          openPositionCount: 1
        }
      ]
    });

    expect(result.metricType).toBe('net_worth');
    expect(result.latestNetWorthSol).toBeCloseTo(2);
    expect(result.latestWalletSol).toBeCloseTo(1.2);
    expect(result.dailyEquity).toEqual([
      { date: '2026-04-17', netWorthSol: 1.91 },
      { date: '2026-04-18', netWorthSol: 2 }
    ]);
  });
});
