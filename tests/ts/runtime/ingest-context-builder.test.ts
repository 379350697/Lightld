import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CandidateScanRecord } from '../../../src/evolution';
import { GMGN_SAFETY_DEFERRED_ERROR } from '../../../src/ingest/gmgn/token-safety-client';
import { buildLiveCycleInputFromIngest } from '../../../src/runtime/ingest-context-builder';

describe('buildLiveCycleInputFromIngest', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a large-pool context selecting the highest-liquidity candidate after safety filtering', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'large-pool-v1',
      traderWallet: 'wallet-1',
      requestedPositionSol: 0.2,
      now: new Date('2026-03-22T10:00:00.000Z'),
      safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-meme',
          baseMint: 'mint-meme',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'MEME',
          liquidityUsd: 90_000,
          volume_24h: 500,
          created_at: new Date('2026-03-21T09:59:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          updatedAt: '2026-03-22T09:59:00.000Z'
        },
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 65_000,
          volume_24h: 45_000,
          created_at: new Date('2026-03-21T09:58:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 160,
          timestamp: '2026-03-22T09:57:00.000Z'
        }
      ],
      fetchGmgnTraderImpl: async () => ({
        wallet: 'wallet-1',
        labels: ['smart-money'],
        pnlUsd: 1_250,
        updatedAt: '2026-03-22T09:56:00.000Z'
      })
    });

    expect(result.requestedPositionSol).toBe(0.2);
    expect(result.sessionPhase).toBe('active');
    expect(result.context.pool).toMatchObject({
      address: 'pool-meme',
      liquidityUsd: 90_000,
      hasSolRoute: true
    });
    expect(result.context.token).toMatchObject({
      mint: 'mint-meme',
      symbol: 'MEME',
      hasSolRoute: true
    });
    expect(result.context.trader).toMatchObject({
      wallet: 'wallet-1',
      labels: ['smart-money']
    });
    expect(result.context.pool).not.toHaveProperty('score');
    expect(result.context.token).not.toHaveProperty('score');
    expect(result.context.route).toMatchObject({
      poolAddress: 'pool-meme',
      token: 'MEME',
      expectedOutSol: 0.2
    });
  });

  it('skips recently closed fresh mint candidates and selects the next safe candidate', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:10:00.000Z'),
      safetyFilterConfig: { disabled: true, minHolders: 0, minBluechipPct: 0, minSafetyScore: 0 },
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'dca-out',
        lifecycleState: 'closed',
        lastClosedMint: 'mint-closed',
        lastClosedAt: '2026-03-22T10:00:00.000Z',
        updatedAt: '2026-03-22T10:00:00.000Z'
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-closed',
          baseMint: 'mint-closed',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'CLOSED',
          liquidityUsd: 40_000,
          created_at: new Date('2026-03-22T09:50:00.000Z').getTime(),
          pool_config: { bin_step: 120, base_fee_pct: 1 },
          volume: { '24h': 2_000_000 },
          fee_tvl_ratio: { '24h': 0.20 }
        },
        {
          address: 'pool-next',
          baseMint: 'mint-next',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'NEXT',
          liquidityUsd: 35_000,
          created_at: new Date('2026-03-22T09:51:00.000Z').getTime(),
          pool_config: { bin_step: 120, base_fee_pct: 1 },
          volume: { '24h': 2_000_000 },
          fee_tvl_ratio: { '24h': 0.10 }
        }
      ],
      fetchPumpTradesImpl: async () => [
        { mint: 'mint-closed', symbol: 'CLOSED', holders: 1200, timestamp: '2026-03-22T09:55:00.000Z' },
        { mint: 'mint-next', symbol: 'NEXT', holders: 1200, timestamp: '2026-03-22T09:56:00.000Z' }
      ]
    });

    expect(result.context.pool).toMatchObject({ address: 'pool-next' });
    expect(result.context.token).toMatchObject({ mint: 'mint-next' });
  });

  it('derives new-token inventory from real account holdings', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      traderWallet: 'wallet-1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00'),
      safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [
          { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
        ],
        journalTokens: [
          { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
        ],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 12_500,
          created_at: new Date('2026-03-21T09:58:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          volume_5m: 4_000,
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 48,
          timestamp: '2026-03-22T09:57:00.000Z'
        }
      ]
    });

    expect(result.sessionPhase).toBe('active');
    expect(result.context.pool).toMatchObject({
      address: 'pool-safe',
      liquidityUsd: 12_500
    });
    expect(result.context.token).toMatchObject({
      symbol: 'SAFE',
      inSession: true
    });
    expect(result.context.trader).toMatchObject({
      wallet: 'wallet-1',
      hasInventory: true
    });
  });

  it('applies a conservative safety-based position cap for selected new-token candidates', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-risky',
          baseMint: 'mint-risky',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'RSK',
          liquidityUsd: 65_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          }
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-risky',
          symbol: 'RSK',
          holders: 90,
          timestamp: '2026-03-22T09:56:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl: async () => [
        {
          mint: 'mint-risky',
          safe: true,
          safetyScore: 68,
          maxScore: 120
        }
      ]
    });

    expect(result.requestedPositionSol).toBe(0.07);
    expect(result.context.route).toMatchObject({
      expectedOutSol: 0.07
    });
  });

  it('defers uncached GMGN safety checks when active LP exposure is already at capacity', async () => {
    const fetchTokenSafetyBatchImpl = vi.fn(async () => {
      throw new Error('safety fetch should be deferred while exposure is at capacity');
    });

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      maxActivePositions: 1,
      now: new Date('2026-03-22T10:00:00.000Z'),
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [
          { poolAddress: 'pool-open', positionAddress: 'pos-open', mint: 'mint-open', hasLiquidity: true }
        ],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-risky',
          baseMint: 'mint-risky',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'RSK',
          liquidityUsd: 65_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          }
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-risky',
          symbol: 'RSK',
          holders: 90,
          timestamp: '2026-03-22T09:56:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl
    });

    expect(fetchTokenSafetyBatchImpl).not.toHaveBeenCalled();
    expect(result.context.route).toMatchObject({
      blockReason: 'gmgn-safety-deferred'
    });
  });

  it('continues GMGN safety checks and can select a new entry when active LP capacity remains', async () => {
    const fetchTokenSafetyBatchImpl = vi.fn(async () => [
      {
        mint: 'mint-risky',
        safe: true,
        safetyScore: 90,
        maxScore: 120
      }
    ]);

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      maxActivePositions: 5,
      now: new Date('2026-03-22T10:00:00.000Z'),
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [
          { poolAddress: 'pool-open', positionAddress: 'pos-open', mint: 'mint-open', hasLiquidity: true }
        ],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-risky',
          baseMint: 'mint-risky',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'RSK',
          liquidityUsd: 65_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          }
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-risky',
          symbol: 'RSK',
          holders: 90,
          timestamp: '2026-03-22T09:56:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl
    });

    expect(fetchTokenSafetyBatchImpl).toHaveBeenCalledWith(['mint-risky']);
    expect(result.context.pool).toMatchObject({
      address: 'pool-risky'
    });
    expect(result.context.token).toMatchObject({
      mint: 'mint-risky'
    });
  });

  it('derives lp position state from Meteora positions even without token inventory', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      traderWallet: 'wallet-1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00'),
      safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [
          { poolAddress: 'pool-safe', positionAddress: 'pos-1', mint: 'mint-safe', hasLiquidity: true }
        ],
        journalLpPositions: [
          { poolAddress: 'pool-safe', positionAddress: 'pos-1', mint: 'mint-safe', hasLiquidity: true }
        ],
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 12_500,
          created_at: new Date('2026-03-21T09:58:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          volume_5m: 4_000,
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 48,
          timestamp: '2026-03-22T09:57:00.000Z'
        }
      ]
    });

    expect(result.context.trader).toMatchObject({
      wallet: 'wallet-1',
      hasInventory: true,
      hasLpPosition: true
    });
  });

  it('derives lp SOL depletion progress from Meteora positions for exit decisions', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      traderWallet: 'wallet-1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00'),
      safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [
          {
            poolAddress: 'pool-safe',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            lowerBinId: 100,
            upperBinId: 168,
            activeBinId: 167,
            solSide: 'tokenX',
            solDepletedBins: 67,
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-safe',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            lowerBinId: 100,
            upperBinId: 168,
            activeBinId: 167,
            solSide: 'tokenX',
            solDepletedBins: 67,
            hasLiquidity: true
          }
        ],
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 12_500,
          created_at: new Date('2026-03-21T09:58:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          volume_5m: 4_000,
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 48,
          timestamp: '2026-03-22T09:57:00.000Z'
        }
      ]
    });

    expect(result.context.trader).toMatchObject({
      wallet: 'wallet-1',
      hasInventory: true,
      hasLpPosition: true,
      lpSolDepletedBins: 67
    });
  });

  it('keeps active LP context without blocking on GMGN safety', async () => {
    const fetchTokenSafetyBatchImpl = vi.fn(async () => {
      throw new Error('safety fetch should not run for active LP maintenance');
    });

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      traderWallet: 'wallet-1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00'),
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        lastReason: 'lp-open-approved',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-safe',
        chainPositionAddress: 'pos-1',
        lifecycleState: 'open',
        entrySol: 0.123,
        entrySolSource: 'actual_fill',
        openedAt: '2026-03-22T09:58:00.000Z',
        updatedAt: '2026-03-22T09:58:00.000Z'
      } as any,
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [
          {
            poolAddress: 'pool-safe',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            currentValueSol: 0.123,
            liquidityValueSol: 0.122,
            unclaimedFeeValueSol: 0.001,
            claimedFeeValueSol: 0,
            lpTotalValueSol: 0.123,
            exitQuoteValueSol: 0.123,
            displayValueSol: 0.123,
            unclaimedFeeSol: 0.001,
            valuationStatus: 'ready',
            valuationCompleteness: 'complete',
            valuationTrust: 'exit_quote',
            valuationReason: '',
            valuationSource: 'meteora-withdraw-simulation+meteora-dlmm-swap-quote',
            hasLiquidity: true
          }
        ],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 12_500,
          created_at: new Date('2026-03-21T09:58:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          volume_5m: 4_000,
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 48,
          timestamp: '2026-03-22T09:57:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl
    });

    expect(fetchTokenSafetyBatchImpl).not.toHaveBeenCalled();
    expect(result.context.pool).toMatchObject({
      address: 'pool-safe',
      liquidityUsd: 24.6,
      hasSolRoute: true
    });
    expect(result.context.token).toMatchObject({
      mint: 'mint-safe',
      symbol: 'mint-s'
    });
    expect(result.context.trader).toMatchObject({
      wallet: 'wallet-1',
      hasInventory: true,
      hasLpPosition: true,
      lpCurrentValueSol: 0.123,
      lpLiquidityValueSol: 0.122,
      lpTotalValueSol: 0.123,
      exitQuoteValueSol: 0.123,
      displayValueSol: 0.123,
      lpUnclaimedFeeSol: 0.001,
      lpUnclaimedFeeValueSol: 0.001,
      lpClaimedFeeValueSol: 0,
      valuationStatus: 'ready',
      valuationCompleteness: 'complete',
      valuationTrust: 'exit_quote',
      valuationSource: 'meteora-withdraw-simulation+meteora-dlmm-swap-quote',
      lpValuationStatus: 'ready',
      lpValuationCompleteness: 'complete',
      lpValuationTrust: 'exit_quote',
      lpValuationSource: 'meteora-withdraw-simulation+meteora-dlmm-swap-quote'
    });
  });

  it('does not select an unrelated LP position when positionState activeMint is missing from the account', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      traderWallet: 'wallet-1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00'),
      selectionMode: 'maintenance-only',
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        lastReason: 'lp-open-approved',
        activeMint: 'mint-active',
        activePoolAddress: 'pool-active',
        chainPositionAddress: 'pos-active',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        openedAt: '2026-03-22T09:58:00.000Z',
        updatedAt: '2026-03-22T09:58:00.000Z'
      } as any,
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [
          {
            poolAddress: 'pool-stale',
            positionAddress: 'pos-stale',
            mint: 'mint-stale',
            currentValueSol: 0.05,
            hasLiquidity: true,
            valuationStatus: 'ready',
            lastValuationAt: '2026-03-22T09:00:00.000Z'
          }
        ],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [],
      fetchPumpTradesImpl: async () => [],
      fetchTokenSafetyBatchImpl: async () => []
    });

    expect(result.context.pool).toMatchObject({
      address: 'pool-stale'
    });
  });

  it('does not mark token-side LP valuation ready without swap quote evidence', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      traderWallet: 'wallet-1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00'),
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [
          {
            poolAddress: 'pool-safe',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            currentValueSol: 0.123,
            liquidityValueSol: 0.122,
            withdrawSolAmount: 0.02,
            withdrawTokenAmountRaw: '1000000',
            unclaimedFeeValueSol: 0.001,
            claimedFeeValueSol: 0,
            lpTotalValueSol: 0.123,
            unclaimedFeeSol: 0.001,
            valuationStatus: 'ready',
            valuationCompleteness: 'complete',
            valuationReason: '',
            valuationSource: 'meteora-withdraw-simulation',
            hasLiquidity: true
          }
        ],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 12_500,
          created_at: new Date('2026-03-21T09:58:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          volume_5m: 4_000,
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 48,
          timestamp: '2026-03-22T09:57:00.000Z'
        }
      ]
    });

    expect(result.context.trader).toMatchObject({
      wallet: 'wallet-1',
      hasInventory: true,
      hasLpPosition: true,
      valuationStatus: 'unavailable',
      valuationCompleteness: 'incomplete',
      lpValuationStatus: 'unavailable',
      lpValuationCompleteness: 'incomplete'
    });
    expect(result.context.trader).not.toHaveProperty('lpCurrentValueSol');
    expect(result.context.trader).not.toHaveProperty('lpTotalValueSol');
  });

  it('does not treat empty Meteora position accounts as funded inventory', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      traderWallet: 'wallet-1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00'),
      safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [
          { poolAddress: 'pool-safe', positionAddress: 'pos-1', mint: 'mint-safe', hasLiquidity: false }
        ],
        journalLpPositions: [
          { poolAddress: 'pool-safe', positionAddress: 'pos-1', mint: 'mint-safe', hasLiquidity: false }
        ],
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 12_500,
          created_at: new Date('2026-03-21T09:58:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          volume_5m: 4_000,
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 48,
          timestamp: '2026-03-22T09:57:00.000Z'
        }
      ]
    });

    expect(result.context.trader).toMatchObject({
      wallet: 'wallet-1',
      hasInventory: false,
      hasLpPosition: false
    });
  });

  it('does not infer inventory from pump wallet flow when real holdings are empty', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      traderWallet: 'wallet-1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00'),
      safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 12_500,
          created_at: new Date('2026-03-21T09:58:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          volume_5m: 4_000,
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 48,
          timestamp: '2026-03-22T09:57:00.000Z'
        },
        {
          wallet: 'wallet-1',
          mint: 'mint-safe',
          side: 'buy',
          amount: 2,
          timestamp: '2026-03-22T09:59:00.000Z'
        }
      ]
    });

    expect(result.context.trader).toMatchObject({
      wallet: 'wallet-1',
      hasInventory: false
    });
  });

  it('returns a safe fallback context when ingest finds no eligible pools', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'large-pool-v1',
      requestedPositionSol: 0.15,
      now: new Date('2026-03-22T10:00:00.000Z'),
      safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
      fetchMeteoraPoolsImpl: async () => [],
      fetchPumpTradesImpl: async () => []
    });

    expect(result.requestedPositionSol).toBe(0.15);
    expect(result.context.pool).toMatchObject({
      address: '',
      liquidityUsd: 0,
      hasSolRoute: false
    });
    expect(result.context.token).toMatchObject({
      symbol: '',
      hasSolRoute: false
    });
    expect(result.context.route).toMatchObject({
      poolAddress: '',
      expectedOutSol: 0.15,
      hasSolRoute: false,
      blockReason: 'no-prefiltered-candidate'
    });
  });

  it('degrades to a fallback context when Meteora pool fetch throws instead of bubbling the daemon into circuit open', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'large-pool-v1',
      requestedPositionSol: 0.15,
      now: new Date('2026-03-22T10:00:00.000Z'),
      safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
      fetchMeteoraPoolsImpl: async () => {
        throw new TypeError('fetch failed');
      },
      fetchPumpTradesImpl: async () => []
    });

    expect(result.requestedPositionSol).toBe(0.15);
    expect(result.context.pool).toMatchObject({
      address: '',
      liquidityUsd: 0,
      hasSolRoute: false
    });
    expect(result.context.route).toMatchObject({
      poolAddress: '',
      expectedOutSol: 0.15,
      hasSolRoute: false,
      blockReason: 'meteora-pools-fetch-failed'
    });
    expect((result.context.route as { blockDetails?: string }).blockDetails).toContain('fetch failed');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Ingest] Meteora pools fetch failed')
    );
  });

  it('returns a safety-specific fallback reason when all LP candidates fail due to GMGN script errors', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 20_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          }
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 50,
          timestamp: '2026-03-22T09:56:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl: async () => [
        {
          mint: 'mint-safe',
          safe: false,
          safetyScore: 0,
          maxScore: 120,
          error: 'script_error: ModuleNotFoundError: No module named scrapling'
        }
      ]
    });

    expect(result.context.route).toMatchObject({
      blockReason: 'gmgn-safety-script-error'
    });
    expect((result.context.route as { blockDetails?: string }).blockDetails).toContain('ModuleNotFoundError');
  });

  it('fails closed with a safety-specific fallback reason when GMGN safety fetching throws', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-risky',
          baseMint: 'mint-risky',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'RSK',
          liquidityUsd: 20_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          }
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-risky',
          symbol: 'RSK',
          holders: 50,
          timestamp: '2026-03-22T09:56:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl: async () => {
        throw new Error('gmgn safety outage');
      }
    });

    expect(result.context.pool).toMatchObject({
      address: '',
      hasSolRoute: false
    });
    expect(result.context.route).toMatchObject({
      poolAddress: '',
      blockReason: 'gmgn-safety-check-failed'
    });
    expect((result.context.route as { blockDetails?: string }).blockDetails).toContain('gmgn safety outage');
  });

  it('continues through safety and selects a candidate outside the old scan window gate', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:20:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 20_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          }
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 50,
          timestamp: '2026-03-22T10:19:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl: async () => [
        {
          mint: 'mint-safe',
          safe: true,
          safetyScore: 90,
          maxScore: 120,
          holders: 50,
          bluechipPct: 0.3
        }
      ]
    });

    expect(result.context.pool).toMatchObject({
      address: 'pool-safe'
    });
    expect(result.context.token).toMatchObject({
      mint: 'mint-safe',
      symbol: 'SAFE'
    });
    expect(result.context.route).toMatchObject({
      poolAddress: 'pool-safe',
      token: 'SAFE'
    });
  });

  it('still reports gmgn-safety-deferred when the safety client explicitly defers checks', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 20_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          }
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 50,
          timestamp: '2026-03-22T09:59:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl: async () => [
        {
          mint: 'mint-safe',
          safe: false,
          safetyScore: 0,
          maxScore: 120,
          error: GMGN_SAFETY_DEFERRED_ERROR
        }
      ]
    });

    expect(result.context.route).toMatchObject({
      blockReason: 'gmgn-safety-deferred'
    });
    expect((result.context.route as { blockDetails?: string }).blockDetails).toContain('batch throttling');
  });

  it('applies LP selection thresholds from config before choosing a candidate', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00'),
      safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-low-volume',
          baseMint: 'mint-low-volume',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'LOWVOL',
          liquidityUsd: 12_000,
          created_at: new Date('2026-03-21T09:58:00.000Z').getTime(),
          updatedAt: '2026-03-22T09:58:00.000Z',
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 10_000
          },
          fee_tvl_ratio: {
            '24h': 0.02
          }
        },
        {
          address: 'pool-good',
          baseMint: 'mint-good',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'GOOD',
          liquidityUsd: 20_000,
          created_at: new Date('2026-03-21T09:57:00.000Z').getTime(),
          updatedAt: '2026-03-22T09:57:00.000Z',
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 1_500_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          }
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-low-volume',
          symbol: 'LOWVOL',
          holders: 50,
          timestamp: '2026-03-22T09:56:00.000Z'
        },
        {
          mint: 'mint-good',
          symbol: 'GOOD',
          holders: 50,
          timestamp: '2026-03-22T09:56:30.000Z'
        }
      ]
    });

    expect(result.context.pool).toMatchObject({
      address: 'pool-good'
    });
    expect(result.context.token).toMatchObject({
      symbol: 'GOOD'
    });
  });

  it('applies auxiliary signal enrichment after safety filtering before candidate selection', async () => {
    const scans: CandidateScanRecord[] = [];
    const enrichmentInputs: string[][] = [];

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00.000Z'),
      candidateScanSink: {
        appendScan: async (scan) => {
          scans.push(scan);
        }
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-steady',
          baseMint: 'mint-steady',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'STEADY',
          liquidityUsd: 20_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          updatedAt: '2026-03-22T09:58:00.000Z'
        },
        {
          address: 'pool-hot',
          baseMint: 'mint-hot',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'HOT',
          liquidityUsd: 19_000,
          created_at: new Date('2026-03-21T10:01:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          updatedAt: '2026-03-22T09:57:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-steady',
          symbol: 'STEADY',
          holders: 90,
          timestamp: '2026-03-22T09:56:00.000Z'
        },
        {
          mint: 'mint-hot',
          symbol: 'HOT',
          holders: 100,
          timestamp: '2026-03-22T09:55:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl: async () => [
        {
          mint: 'mint-steady',
          safe: true,
          safetyScore: 80,
          maxScore: 120
        },
        {
          mint: 'mint-hot',
          safe: true,
          safetyScore: 75,
          maxScore: 120
        }
      ],
      enrichAuxiliarySignalsImpl: async (candidates) => {
        enrichmentInputs.push(candidates.map((candidate) => `${candidate.mint}:${candidate.safetyScore ?? 0}`));

        return candidates.map((candidate) =>
          candidate.mint === 'mint-hot'
            ? {
              ...candidate,
              auxSignalScore: 12,
              dexscreenerBoostAmount: 55,
              dexscreenerHasProfile: true,
              jupiterOrganicScore: 70,
              jupiterTrendingRank: 3,
              coingeckoTrendingRank: 9,
              auxSignalStatus: 'partial' as const
            }
            : {
              ...candidate,
              auxSignalScore: 0,
              auxSignalStatus: 'unavailable' as const
            }
        );
      }
    });

    expect(enrichmentInputs).toEqual([['mint-steady:80', 'mint-hot:75']]);
    expect(result.context.pool).toMatchObject({
      address: 'pool-hot',
      auxSignalScore: 12,
      auxSignalStatus: 'partial'
    });
    expect(result.context.token).toMatchObject({
      mint: 'mint-hot',
      dexscreenerBoostAmount: 55,
      dexscreenerHasProfile: true,
      jupiterOrganicScore: 70,
      jupiterTrendingRank: 3,
      coingeckoTrendingRank: 9
    });
    expect(scans[0]?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tokenMint: 'mint-hot',
        selected: true,
        safetyScore: 75,
        auxSignalScore: 12,
        auxSignalStatus: 'partial'
      })
    ]));
  });

  it('fails open when auxiliary signal enrichment throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 20_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 90,
          timestamp: '2026-03-22T09:56:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl: async () => [
        {
          mint: 'mint-safe',
          safe: true,
          safetyScore: 80,
          maxScore: 120
        }
      ],
      enrichAuxiliarySignalsImpl: async () => {
        throw new Error('signals-down');
      }
    });

    expect(result.context.token).toMatchObject({
      mint: 'mint-safe',
      symbol: 'SAFE'
    });
    expect(result.context.pool).toMatchObject({
      auxSignalScore: 0,
      auxSignalStatus: 'disabled'
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Auxiliary signal enrichment failed open'));
  });

  it('emits structured candidate scan evidence with selected and rejected candidates', async () => {
    const scans: CandidateScanRecord[] = [];

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00.000Z'),
      candidateScanSink: {
        appendScan: async (scan) => {
          scans.push(scan);
        }
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 20_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          updatedAt: '2026-03-22T09:58:00.000Z'
        },
        {
          address: 'pool-risky',
          baseMint: 'mint-risky',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'RISK',
          liquidityUsd: 18_000,
          created_at: new Date('2026-03-21T10:01:00.000Z').getTime(),
          pool_config: {
            bin_step: 130,
            base_fee_pct: 1
          },
          volume: {
            '24h': 1_500_000
          },
          fee_tvl_ratio: {
            '24h': 0.02
          },
          updatedAt: '2026-03-22T09:57:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 50,
          timestamp: '2026-03-22T09:56:00.000Z'
        },
        {
          mint: 'mint-risky',
          symbol: 'RISK',
          holders: 20,
          timestamp: '2026-03-22T09:55:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl: async () => [
        {
          mint: 'mint-safe',
          safe: true,
          safetyScore: 95,
          maxScore: 120
        },
        {
          mint: 'mint-risky',
          safe: false,
          safetyScore: 12,
          maxScore: 120,
          rejectReasons: ['top10-holders-too-high']
        }
      ]
    });

    expect(result.context.token).toMatchObject({
      mint: 'mint-safe',
      symbol: 'SAFE'
    });
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({
      strategyId: 'new-token-v1',
      poolCount: 2,
      prefilteredCount: 2,
      postLpCount: 2,
      postSafetyCount: 1,
      selectedTokenMint: 'mint-safe',
      selectedPoolAddress: 'pool-safe'
    });
    expect(scans[0].candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tokenMint: 'mint-safe',
          tokenSymbol: 'SAFE',
          selected: true,
          rejectionStage: 'none',
          blockedReason: ''
        }),
        expect.objectContaining({
          tokenMint: 'mint-risky',
          tokenSymbol: 'RISK',
          selected: false,
          rejectionStage: 'safety',
          blockedReason: 'top10-holders-too-high'
        })
      ])
    );
  });

  it('swallows candidate scan sink failures and still returns the selected context', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      now: new Date('2026-03-22T10:00:00.000Z'),
      candidateScanSink: {
        appendScan: async () => {
          throw new Error('disk-full');
        }
      },
      fetchMeteoraPoolsImpl: async () => [
        {
          address: 'pool-safe',
          baseMint: 'mint-safe',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseSymbol: 'SAFE',
          liquidityUsd: 20_000,
          created_at: new Date('2026-03-21T10:00:00.000Z').getTime(),
          pool_config: {
            bin_step: 120,
            base_fee_pct: 1
          },
          volume: {
            '24h': 2_000_000
          },
          fee_tvl_ratio: {
            '24h': 0.03
          },
          updatedAt: '2026-03-22T09:58:00.000Z'
        }
      ],
      fetchPumpTradesImpl: async () => [
        {
          mint: 'mint-safe',
          symbol: 'SAFE',
          holders: 50,
          timestamp: '2026-03-22T09:56:00.000Z'
        }
      ],
      fetchTokenSafetyBatchImpl: async () => [
        {
          mint: 'mint-safe',
          safe: true,
          safetyScore: 95,
          maxScore: 120
        }
      ]
    });

    expect(result.context.token).toMatchObject({
      mint: 'mint-safe',
      symbol: 'SAFE'
    });
  });
});
