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

  it('prefers solana-chain closed position snapshots over local estimated LP history', () => {
    const result = buildHistoricalActivity({
      fills: [
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          side: 'withdraw-lp',
          submissionId: 'sub-close',
          filledSol: 0,
          recordedAt: '2026-04-22T14:39:45.589Z'
        }
      ],
      orderFallback: [
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          action: 'add-lp',
          submissionId: 'sub-open',
          idempotencyKey: 'order-open',
          requestedPositionSol: 0.05,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-22T13:07:01.000Z',
          updatedAt: '2026-04-22T13:07:07.000Z'
        },
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          action: 'withdraw-lp',
          submissionId: 'sub-close',
          idempotencyKey: 'order-close',
          requestedPositionSol: 0.02,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-22T14:39:40.000Z',
          updatedAt: '2026-04-22T14:39:45.000Z'
        }
      ],
      chainSnapshots: [
        {
          walletAddress: 'wallet-1',
          tokenMint: 'mint-earth',
          tokenSymbol: '',
          poolAddress: 'pool-1',
          positionAddress: 'position-1',
          openedAt: '2026-04-22T13:07:07.421Z',
          closedAt: '2026-04-22T14:39:45.589Z',
          depositSol: 0.05,
          depositTokenAmount: 0,
          withdrawSol: 0,
          withdrawTokenAmount: 33102.757743,
          withdrawTokenValueSol: 0.0356656507,
          feeSol: 0.001827296,
          feeTokenAmount: 3387.359479,
          feeTokenValueSol: 0.0036496159,
          pnlSol: -0.0088574374,
          source: 'solana-chain',
          confidence: 'exact'
        }
      ],
      limit: 5
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tokenMint: 'mint-earth',
      tokenSymbol: 'earthcoin',
      action: 'add-lp -> withdraw-lp',
      source: 'matched',
      confirmationStatus: 'ok',
      openedAt: '2026-04-22T13:07:07.421Z',
      closedAt: '2026-04-22T14:39:45.589Z',
      investedSol: 0.05,
    });
    expect(result[0]?.feeEarnedSol).toBeCloseTo(0.0054769119);
    expect(result[0]?.pnlSol).toBeCloseTo(-0.0088574374);
    expect(result[0]?.pnlPct).toBeCloseTo(-17.7148748);
    expect(result[0]?.dprPct).toBeCloseTo(-17.7148748);
  });

  it('ignores invalid chain snapshots with zero deposit or reversed time', () => {
    const result = buildHistoricalActivity({
      fills: [],
      orderFallback: [],
      chainSnapshots: [
        {
          walletAddress: 'wallet-1',
          tokenMint: 'mint-bad',
          tokenSymbol: 'BAD',
          poolAddress: 'pool-bad',
          positionAddress: 'position-bad',
          openedAt: '2026-04-22T14:40:37.000Z',
          closedAt: '2026-04-22T14:39:45.000Z',
          depositSol: 0,
          depositTokenAmount: 0,
          withdrawSol: 0.1,
          withdrawTokenAmount: 0,
          withdrawTokenValueSol: 0,
          feeSol: 0,
          feeTokenAmount: 0,
          feeTokenValueSol: 0,
          pnlSol: 0.1,
          source: 'solana-chain',
          confidence: 'exact'
        }
      ],
      limit: 5
    });

    expect(result).toEqual([]);
  });

  it('hides stale missing-chain history residue older than one day', () => {
    const result = buildHistoricalActivity({
      fills: [],
      orderFallback: [
        {
          tokenMint: 'mint-old',
          tokenSymbol: 'OLD',
          action: 'withdraw-lp',
          submissionId: '',
          idempotencyKey: 'order-old',
          requestedPositionSol: 0.05,
          confirmationStatus: 'unknown',
          createdAt: '2026-04-20T16:09:46.743Z',
          updatedAt: '2026-04-20T16:10:30.908Z'
        }
      ],
      chainSnapshots: [
        {
          walletAddress: 'wallet-1',
          tokenMint: 'mint-real',
          tokenSymbol: 'REAL',
          poolAddress: 'pool-real',
          positionAddress: 'position-real',
          openedAt: '2026-04-22T10:00:00.000Z',
          closedAt: '2026-04-22T12:00:00.000Z',
          depositSol: 0.05,
          depositTokenAmount: 0,
          withdrawSol: 0.04,
          withdrawTokenAmount: 0,
          withdrawTokenValueSol: 0,
          feeSol: 0.001,
          feeTokenAmount: 0,
          feeTokenValueSol: 0,
          pnlSol: -0.009,
          source: 'solana-chain',
          confidence: 'exact'
        }
      ],
      now: new Date('2026-04-23T02:00:00.000Z'),
      limit: 5
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tokenMint: 'mint-real',
      source: 'matched',
      confirmationStatus: 'ok'
    });
  });

  it('keeps recent missing-chain history errors within one day', () => {
    const result = buildHistoricalActivity({
      fills: [],
      orderFallback: [
        {
          tokenMint: 'mint-recent',
          tokenSymbol: 'REC',
          action: 'withdraw-lp',
          submissionId: '',
          idempotencyKey: 'order-recent',
          requestedPositionSol: 0.05,
          confirmationStatus: 'unknown',
          createdAt: '2026-04-22T18:09:46.743Z',
          updatedAt: '2026-04-22T18:10:30.908Z'
        }
      ],
      now: new Date('2026-04-23T02:00:00.000Z'),
      limit: 5
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tokenMint: 'mint-recent',
      source: 'error',
      confirmationStatus: 'missing-chain'
    });
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

    expect(result).toHaveLength(1);
    expect(result).toMatchObject([
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

    expect(result).toHaveLength(1);
    expect(result).toMatchObject([
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

    expect(result).toHaveLength(1);
    expect(result).toMatchObject([
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

    expect(result).toHaveLength(1);
    expect(result).toMatchObject([
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
          recordedAt: '2026-04-18T08:02:00.000Z'
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
          recordedAt: '2026-04-18T09:02:00.000Z'
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
          createdAt: '2026-04-18T08:01:55.000Z',
          updatedAt: '2026-04-18T08:01:56.000Z'
        },
        {
          tokenMint: 'mint-strong',
          tokenSymbol: 'STR',
          action: 'withdraw-lp',
          submissionId: '',
          idempotencyKey: 'order-noise-close',
          requestedPositionSol: 0.91,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T09:01:55.000Z',
          updatedAt: '2026-04-18T09:01:56.000Z'
        }
      ],
      limit: 5
    });

    expect(result).toHaveLength(2);
    expect(result).toMatchObject([
      {
        tokenMint: 'mint-strong',
        tokenSymbol: 'STR',
        action: 'add-lp -> withdraw-lp',
        amountSol: 0.6,
        recordedAt: '2026-04-18T09:02:00.000Z',
        source: 'matched',
        confirmationStatus: 'ok'
      },
      {
        tokenMint: 'mint-strong',
        tokenSymbol: 'STR',
        action: 'add-lp -> withdraw-lp',
        amountSol: 0.61,
        recordedAt: '2026-04-18T09:01:56.000Z',
        source: 'error',
        confirmationStatus: 'missing-chain'
      }
    ]);
  });

  it('does not strong-match records when token mint differs even if identity matches', () => {
    const result = buildHistoricalActivity({
      fills: [
        {
          tokenMint: 'mint-chain',
          tokenSymbol: 'CHAIN',
          side: 'unknown',
          submissionId: '',
          openIntentId: 'intent-shared',
          positionId: 'position-shared',
          chainPositionAddress: 'chain-pos-shared',
          filledSol: 0,
          recordedAt: '2026-04-18T08:02:00.000Z'
        }
      ],
      orderFallback: [
        {
          tokenMint: 'mint-local',
          tokenSymbol: 'LOCAL',
          action: 'add-lp',
          submissionId: '',
          idempotencyKey: 'order-local-open',
          openIntentId: 'intent-shared',
          positionId: 'position-shared',
          chainPositionAddress: 'chain-pos-shared',
          requestedPositionSol: 0.4,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T08:02:01.000Z',
          updatedAt: '2026-04-18T08:02:02.000Z'
        }
      ],
      limit: 5
    });

    expect(result).toHaveLength(1);
    expect(result).toMatchObject([
      {
        tokenMint: 'mint-local',
        tokenSymbol: 'LOCAL',
        action: 'add-lp',
        source: 'error',
        confirmationStatus: 'missing-chain'
      }
    ]);
  });

  it('does not strong-match open records when chain and local open times differ by more than 3 minutes', () => {
    const result = buildHistoricalActivity({
      fills: [
        {
          tokenMint: 'mint-open-window',
          tokenSymbol: 'WIN',
          side: 'unknown',
          submissionId: '',
          openIntentId: 'intent-window',
          positionId: 'position-window',
          chainPositionAddress: 'chain-pos-window',
          filledSol: 0,
          recordedAt: '2026-04-18T08:10:00.000Z'
        }
      ],
      orderFallback: [
        {
          tokenMint: 'mint-open-window',
          tokenSymbol: 'WIN',
          action: 'add-lp',
          submissionId: '',
          idempotencyKey: 'order-window-open',
          openIntentId: 'intent-window',
          positionId: 'position-window',
          chainPositionAddress: 'chain-pos-window',
          requestedPositionSol: 0.4,
          confirmationStatus: 'confirmed',
          createdAt: '2026-04-18T08:00:00.000Z',
          updatedAt: '2026-04-18T08:00:01.000Z'
        }
      ],
      limit: 5
    });

    expect(result).toHaveLength(1);
    expect(result).toMatchObject([
      {
        tokenMint: 'mint-open-window',
        tokenSymbol: 'WIN',
        action: 'add-lp',
        source: 'error',
        confirmationStatus: 'missing-chain'
      }
    ]);
  });

  it('falls back to token lifecycle pairing and decision metrics for local-only lp exits', () => {
    const result = buildHistoricalActivity({
      fills: [
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          side: 'unknown',
          submissionId: 'sub-open-fill',
          filledSol: 0,
          recordedAt: '2026-04-22T13:07:07.421Z'
        }
      ],
      orderFallback: [
        {
          tokenMint: 'mint-earth',
          tokenSymbol: '',
          action: 'add-lp',
          submissionId: '',
          idempotencyKey: 'order-earth-open',
          requestedPositionSol: 0.05,
          confirmationStatus: 'unknown',
          createdAt: '2026-04-22T13:07:01.715Z',
          updatedAt: '2026-04-22T13:07:01.722Z'
        },
        {
          tokenMint: 'mint-earth',
          tokenSymbol: '',
          action: 'withdraw-lp',
          submissionId: '',
          idempotencyKey: 'order-earth-close',
          openIntentId: 'polluted-intent',
          positionId: 'polluted-position',
          chainPositionAddress: 'polluted-chain-position',
          requestedPositionSol: 0.02,
          confirmationStatus: 'unknown',
          createdAt: '2026-04-22T14:39:45.571Z',
          updatedAt: '2026-04-22T14:39:45.589Z'
        }
      ],
      decisionFallback: [
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          action: 'withdraw-lp',
          recordedAt: '2026-04-22T14:40:00.758Z',
          entrySol: 0.05,
          lpCurrentValueSol: 0.042972091,
          lpUnclaimedFeeSol: 0.006224571,
          lpNetPnlPct: -1.61
        }
      ],
      limit: 5
    });

    expect(result).toHaveLength(1);
    expect(result).toMatchObject([
      {
        tokenMint: 'mint-earth',
        tokenSymbol: 'earthcoin',
        action: 'add-lp -> withdraw-lp',
        source: 'error',
        confirmationStatus: 'missing-chain',
        openedAt: '2026-04-22T13:07:07.421Z',
        closedAt: '2026-04-22T14:39:45.589Z',
        investedSol: 0.05,
        feeEarnedSol: 0.006224571
      }
    ]);
    expect(result[0]?.pnlSol).toBeCloseTo(-0.0008033389999999997);
    expect(result[0]?.pnlPct).toBeCloseTo(-1.6066779999999994);
  });

  it('does not fabricate pnl from local-only close requestedPositionSol without trusted exit metrics', () => {
    const result = buildHistoricalActivity({
      fills: [],
      orderFallback: [
        {
          tokenMint: 'mint-local-pnl',
          tokenSymbol: 'LPNL',
          action: 'add-lp',
          submissionId: '',
          idempotencyKey: 'order-local-pnl-open',
          requestedPositionSol: 0.05,
          confirmationStatus: 'unknown',
          createdAt: '2026-04-22T13:07:01.715Z',
          updatedAt: '2026-04-22T13:07:01.722Z'
        },
        {
          tokenMint: 'mint-local-pnl',
          tokenSymbol: 'LPNL',
          action: 'withdraw-lp',
          submissionId: '',
          idempotencyKey: 'order-local-pnl-close',
          requestedPositionSol: 0.02,
          confirmationStatus: 'unknown',
          createdAt: '2026-04-22T14:39:45.571Z',
          updatedAt: '2026-04-22T14:39:45.589Z'
        }
      ],
      limit: 5
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tokenMint: 'mint-local-pnl',
      action: 'add-lp -> withdraw-lp',
      source: 'error',
      confirmationStatus: 'unresolved',
      investedSol: 0.05,
      pnlSol: null,
      pnlPct: null,
      dprPct: null
    });
  });

  it('prefers exit value over pnl percent when reconstructing historical lp pnl', () => {
    const result = buildHistoricalActivity({
      fills: [],
      orderFallback: [
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          action: 'add-lp',
          submissionId: '',
          idempotencyKey: 'order-earth-open',
          requestedPositionSol: 0.05,
          confirmationStatus: 'unknown',
          createdAt: '2026-04-22T13:07:01.715Z',
          updatedAt: '2026-04-22T13:07:01.722Z'
        },
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          action: 'withdraw-lp',
          submissionId: '',
          idempotencyKey: 'order-earth-close',
          requestedPositionSol: 0.02,
          confirmationStatus: 'unknown',
          createdAt: '2026-04-22T14:39:45.571Z',
          updatedAt: '2026-04-22T14:39:45.589Z'
        }
      ],
      decisionFallback: [
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          action: 'withdraw-lp',
          recordedAt: '2026-04-22T14:40:00.758Z',
          entrySol: 0.05,
          lpCurrentValueSol: 0.042972091,
          lpUnclaimedFeeSol: 0.006224571,
          lpNetPnlPct: -60
        }
      ],
      limit: 5
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.pnlSol).toBeCloseTo(-0.0008033389999999997);
    expect(result[0]?.pnlPct).toBeCloseTo(-1.6066779999999994);
  });
});
