import { describe, expect, it } from 'vitest';

import {
  buildCashflowMetrics,
  buildEquityMetrics,
  buildHistoricalActivity
} from '../../../src/dashboard/dashboard-metrics';

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

  it('collapses one matched add and withdraw lifecycle into a single historical order', () => {
    const result = buildHistoricalActivity({
      fills: [
        {
          tokenMint: 'mint-safe',
          tokenSymbol: 'SAFE',
          side: 'add-lp',
          submissionId: 'sub-open',
          filledSol: 1,
          recordedAt: '2026-04-18T08:00:00.000Z'
        },
        {
          tokenMint: 'mint-safe',
          tokenSymbol: 'SAFE',
          side: 'withdraw-lp',
          submissionId: 'sub-close',
          filledSol: 1.4,
          recordedAt: '2026-04-18T09:00:00.000Z'
        }
      ],
      orderFallback: [
        {
          tokenMint: 'mint-safe',
          tokenSymbol: 'SAFE',
          action: 'add-lp',
          submissionId: 'sub-open',
          idempotencyKey: 'order-open',
          requestedPositionSol: 1,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T07:59:00.000Z',
          updatedAt: '2026-04-18T08:00:01.000Z'
        },
        {
          tokenMint: 'mint-safe',
          tokenSymbol: 'SAFE',
          action: 'withdraw-lp',
          submissionId: 'sub-close',
          idempotencyKey: 'order-close',
          requestedPositionSol: 1.4,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T08:59:00.000Z',
          updatedAt: '2026-04-18T09:00:01.000Z'
        }
      ],
      limit: 5
    });

    expect(result).toEqual([
      {
        tokenMint: 'mint-safe',
        tokenSymbol: 'SAFE',
        action: 'add-lp -> withdraw-lp',
        amountSol: 1,
        recordedAt: '2026-04-18T09:00:01.000Z',
        source: 'matched',
        confirmationStatus: 'ok'
      }
    ]);
  });

  it('marks chain-only historical activity as error', () => {
    const result = buildHistoricalActivity({
      fills: [
        {
          tokenMint: 'mint-chain-only',
          tokenSymbol: 'CO',
          side: 'withdraw-lp',
          submissionId: 'sub-chain-only',
          filledSol: 0.7,
          recordedAt: '2026-04-18T09:00:00.000Z'
        }
      ],
      orderFallback: [],
      limit: 5
    });

    expect(result).toEqual([
      {
        tokenMint: 'mint-chain-only',
        tokenSymbol: 'CO',
        action: 'withdraw-lp',
        amountSol: 0.7,
        recordedAt: '2026-04-18T09:00:00.000Z',
        source: 'error',
        confirmationStatus: 'missing-local'
      }
    ]);
  });

  it('marks local-only historical activity as error', () => {
    const result = buildHistoricalActivity({
      fills: [],
      orderFallback: [
        {
          tokenMint: 'mint-local-only',
          tokenSymbol: 'LO',
          action: 'add-lp',
          submissionId: 'sub-local-only',
          idempotencyKey: 'order-local-only',
          requestedPositionSol: 0.5,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T08:59:00.000Z',
          updatedAt: '2026-04-18T09:00:00.000Z'
        }
      ],
      limit: 5
    });

    expect(result).toEqual([
      {
        tokenMint: 'mint-local-only',
        tokenSymbol: 'LO',
        action: 'add-lp',
        amountSol: 0.5,
        recordedAt: '2026-04-18T09:00:00.000Z',
        source: 'error',
        confirmationStatus: 'missing-chain'
      }
    ]);
  });

  it('does not show still-open matched positions as historical orders', () => {
    const result = buildHistoricalActivity({
      fills: [
        {
          tokenMint: 'mint-open',
          tokenSymbol: 'OPEN',
          side: 'add-lp',
          submissionId: 'sub-open',
          filledSol: 0.8,
          recordedAt: '2026-04-18T08:00:00.000Z'
        }
      ],
      orderFallback: [
        {
          tokenMint: 'mint-open',
          tokenSymbol: 'OPEN',
          action: 'add-lp',
          submissionId: 'sub-open',
          idempotencyKey: 'order-open',
          requestedPositionSol: 0.8,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T07:59:00.000Z',
          updatedAt: '2026-04-18T08:00:01.000Z'
        }
      ],
      limit: 5
    });

    expect(result).toEqual([]);
  });

  it('matches chain fills to nearby local orders when fill side and amount are missing', () => {
    const result = buildHistoricalActivity({
      fills: [
        {
          tokenMint: 'mint-fuzzy',
          tokenSymbol: 'FZY',
          side: 'unknown',
          submissionId: 'chain-open',
          filledSol: 0,
          recordedAt: '2026-04-18T08:00:06.000Z'
        },
        {
          tokenMint: 'mint-fuzzy',
          tokenSymbol: 'FZY',
          side: 'unknown',
          submissionId: 'chain-close',
          filledSol: 0,
          recordedAt: '2026-04-18T09:00:08.000Z'
        }
      ],
      orderFallback: [
        {
          tokenMint: 'mint-fuzzy',
          tokenSymbol: 'FZY',
          action: 'add-lp',
          submissionId: '',
          idempotencyKey: 'order-open',
          requestedPositionSol: 0.9,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T08:00:00.000Z',
          updatedAt: '2026-04-18T08:00:02.000Z'
        },
        {
          tokenMint: 'mint-fuzzy',
          tokenSymbol: 'FZY',
          action: 'withdraw-lp',
          submissionId: '',
          idempotencyKey: 'order-close',
          requestedPositionSol: 1.1,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T09:00:00.000Z',
          updatedAt: '2026-04-18T09:00:03.000Z'
        }
      ],
      limit: 5
    });

    expect(result).toEqual([
      {
        tokenMint: 'mint-fuzzy',
        tokenSymbol: 'FZY',
        action: 'add-lp -> withdraw-lp',
        amountSol: 0.9,
        recordedAt: '2026-04-18T09:00:08.000Z',
        source: 'matched',
        confirmationStatus: 'ok'
      }
    ]);
  });

  it('prefers chain position identity over fuzzy time matching', () => {
    const result = buildHistoricalActivity({
      fills: [
        {
          tokenMint: 'mint-strong',
          tokenSymbol: 'STR',
          side: 'unknown',
          submissionId: '',
          openIntentId: 'intent-strong',
          positionId: 'position-strong',
          chainPositionAddress: 'chain-pos-strong',
          filledSol: 0,
          recordedAt: '2026-04-18T08:12:00.000Z'
        },
        {
          tokenMint: 'mint-strong',
          tokenSymbol: 'STR',
          side: 'unknown',
          submissionId: '',
          openIntentId: 'intent-strong',
          positionId: 'position-strong',
          chainPositionAddress: 'chain-pos-strong',
          filledSol: 0,
          recordedAt: '2026-04-18T09:12:00.000Z'
        }
      ],
      orderFallback: [
        {
          tokenMint: 'mint-strong',
          tokenSymbol: 'STR',
          action: 'add-lp',
          submissionId: '',
          idempotencyKey: 'order-strong-open',
          openIntentId: 'intent-strong',
          positionId: 'position-strong',
          chainPositionAddress: 'chain-pos-strong',
          requestedPositionSol: 0.6,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T08:00:00.000Z',
          updatedAt: '2026-04-18T08:00:01.000Z'
        },
        {
          tokenMint: 'mint-strong',
          tokenSymbol: 'STR',
          action: 'withdraw-lp',
          submissionId: '',
          idempotencyKey: 'order-strong-close',
          openIntentId: 'intent-strong',
          positionId: 'position-strong',
          chainPositionAddress: 'chain-pos-strong',
          requestedPositionSol: 0.9,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T09:00:00.000Z',
          updatedAt: '2026-04-18T09:00:01.000Z'
        },
        {
          tokenMint: 'mint-strong',
          tokenSymbol: 'STR',
          action: 'add-lp',
          submissionId: '',
          idempotencyKey: 'order-noise-open',
          requestedPositionSol: 0.61,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T08:11:55.000Z',
          updatedAt: '2026-04-18T08:11:56.000Z'
        },
        {
          tokenMint: 'mint-strong',
          tokenSymbol: 'STR',
          action: 'withdraw-lp',
          submissionId: '',
          idempotencyKey: 'order-noise-close',
          requestedPositionSol: 0.91,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T09:11:55.000Z',
          updatedAt: '2026-04-18T09:11:56.000Z'
        }
      ],
      limit: 5
    });

    expect(result).toEqual([
      {
        tokenMint: 'mint-strong',
        tokenSymbol: 'STR',
        action: 'add-lp -> withdraw-lp',
        amountSol: 0.6,
        recordedAt: '2026-04-18T09:12:00.000Z',
        source: 'matched',
        confirmationStatus: 'ok'
      },
      {
        tokenMint: 'mint-strong',
        tokenSymbol: 'STR',
        action: 'add-lp -> withdraw-lp',
        amountSol: 0.61,
        recordedAt: '2026-04-18T09:11:56.000Z',
        source: 'error',
        confirmationStatus: 'missing-chain'
      }
    ]);
  });
});
