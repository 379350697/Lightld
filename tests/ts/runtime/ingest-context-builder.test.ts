import { afterEach, describe, expect, it, vi } from 'vitest';

import { GMGN_SAFETY_DEFERRED_ERROR } from '../../../src/ingest/gmgn/token-safety-client';
import { buildLiveCycleInputFromIngest } from '../../../src/runtime/ingest-context-builder';

describe('buildLiveCycleInputFromIngest', () => {
  afterEach(() => {
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
});
