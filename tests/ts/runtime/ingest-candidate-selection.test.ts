import { describe, expect, it, vi } from 'vitest';

import type { StrategyConfig } from '../../../src/config/schema';
import {
  applySafetyFilter,
  countActiveInventoryPositions,
  filterLpEligibleCandidates,
  filterRecentlyClosedMintCandidates,
  isInScanWindow,
  rankCandidatesForSafety,
  selectCandidate,
  type IngestCandidate
} from '../../../src/runtime/ingest-candidate-selection';

function makeCandidate(overrides: Partial<IngestCandidate> = {}): IngestCandidate {
  return {
    address: 'pool-1',
    mint: 'mint-1',
    symbol: 'SAFE',
    quoteMint: 'So11111111111111111111111111111111111111112',
    liquidityUsd: 20_000,
    hasSolRoute: true,
    capturedAt: '2026-03-22T10:00:00.000Z',
    holders: 100,
    hasInventory: false,
    hasLpPosition: false,
    binStep: 120,
    baseFeePct: 1,
    volume24h: 2_000_000,
    feeTvlRatio24h: 0.12,
    ...overrides
  };
}

function makeConfig(): StrategyConfig {
  return {
    strategyId: 'new-token-v1',
    poolClass: 'new-token',
    exitMint: 'SOL',
    lpConfig: {
      enabled: true,
      singleSideMint: 'SOL',
      strategyType: 'bid-ask',
      downsideCoveragePct: 66,
      stopLossNetPnlPct: 20,
      takeProfitNetPnlPct: 30,
      solDepletionExitBins: 67,
      minBinStep: 100,
      minVolume24hUsd: 1_000_000,
      minFeeTvlRatio24h: 0,
      rebalanceOnOutOfRange: false
    },
    auxiliarySignals: {
      enabled: false,
      mode: 'rank-only',
      timeoutMs: 800,
      cacheTtlMs: 300_000,
      maxCandidatesPerCycle: 30,
      failOpen: true,
      maxScoreBonus: 25,
      providers: ['dexscreener', 'jupiter', 'coingecko'],
      providerOptions: {
        dexscreener: { enabled: true, weight: 1 },
        jupiter: { enabled: true, weight: 1 },
        coingecko: { enabled: true, weight: 1 },
        birdeye: { enabled: true, weight: 1 }
      }
    },
    hardGates: {
      requireSolRoute: true,
      minLiquidityUsd: 1000
    },
    filters: {
      minLiquidityUsd: 1000
    },
    riskThresholds: {
      maxPositionSol: 0.5,
      maxDailyLossSol: 1
    },
    sessionWindows: [{ start: '00:00', end: '23:59' }],
    solRouteLimits: {
      maxSlippageBps: 100,
      maxImpactBps: 200
    },
    live: {
      enabled: true,
      maxLivePositionSol: 0.15,
      autoFlattenRequired: true,
      maxHoldHours: 10,
      minCloseToOpenIntervalSeconds: 0,
      requireMintAuthorityRevoked: false
    }
  };
}

describe('ingest candidate helpers', () => {
  it('counts active non-SOL Meteora LP positions without charging token inventory to LP capacity', () => {
    expect(countActiveInventoryPositions({
      walletSol: 1,
      journalSol: 1,
      walletLpPositions: [
        { poolAddress: 'pool-lp', positionAddress: 'pos-1', mint: 'mint-lp', hasLiquidity: true }
      ],
      journalLpPositions: [],
      walletTokens: [
        { mint: 'mint-a', symbol: 'AAA', amount: 1 },
        { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', amount: 2 },
        { mint: 'mint-b', symbol: 'BBB', amount: 0 }
      ],
      journalTokens: [],
      fills: []
    })).toBe(1);
  });

  it('does not count empty Meteora position accounts as active LP exposure', () => {
    expect(countActiveInventoryPositions({
      walletSol: 1,
      journalSol: 1,
      walletLpPositions: [
        { poolAddress: 'pool-lp', positionAddress: 'pos-1', mint: 'mint-lp', hasLiquidity: false }
      ],
      journalLpPositions: [],
      walletTokens: [],
      journalTokens: [],
      fills: []
    })).toBe(0);
  });

  it('detects the configured scan windows', () => {
    expect(isInScanWindow(new Date('2026-03-22T10:05:00'))).toBe(true);
    expect(isInScanWindow(new Date('2026-03-22T10:20:00'))).toBe(false);
  });

  it('keeps inventory candidates and filters ineligible LP entries', () => {
    const result = filterLpEligibleCandidates([
      makeCandidate({ address: 'inventory-pool', hasInventory: true, binStep: 10, volume24h: 10 }),
      makeCandidate({ address: 'bad-pool', volume24h: 10 }),
      makeCandidate({ address: 'good-pool' })
    ], makeConfig());

    expect(result.map((candidate) => candidate.address)).toEqual(['inventory-pool', 'good-pool']);
  });

  it('ranks candidates for safety by existing exposure, fee/tvl, liquidity, pool age, then volume', () => {
    const result = rankCandidatesForSafety([
      makeCandidate({ address: 'low-fee', feeTvlRatio24h: 0.05, volume24h: 5_000_000, liquidityUsd: 90_000, capturedAt: '2026-03-20T00:00:00Z' }),
      makeCandidate({ address: 'inventory', hasInventory: true, feeTvlRatio24h: 0.01 }),
      makeCandidate({ address: 'high-fee', feeTvlRatio24h: 0.2, volume24h: 1_000_000, liquidityUsd: 20_000, capturedAt: '2026-03-19T00:00:00Z' }),
      makeCandidate({ address: 'same-fee-higher-liquidity', feeTvlRatio24h: 0.2, volume24h: 2_000_000, liquidityUsd: 50_000, capturedAt: '2026-03-20T00:00:00Z' })
    ]);

    expect(result.map((candidate) => candidate.address)).toEqual([
      'inventory',
      'same-fee-higher-liquidity',
      'high-fee',
      'low-fee'
    ]);
  });

  it('prefers inventory and higher safety candidates when selecting', () => {
    const result = selectCandidate([
      makeCandidate({ address: 'pool-a', hasInventory: false, safetyScore: 80 }),
      makeCandidate({ address: 'pool-b', hasInventory: true, safetyScore: 10 })
    ], 'new-token-v1', 0);

    expect(result?.address).toBe('pool-b');
  });

  it('still selects a fresh candidate outside the old scan window when position capacity is available', () => {
    const result = selectCandidate([
      makeCandidate({ address: 'pool-a', hasInventory: false, safetyScore: 80 }),
      makeCandidate({ address: 'pool-b', hasInventory: false, safetyScore: 70 })
    ], 'new-token-v1', 0);

    expect(result?.address).toBe('pool-a');
  });

  it('does not let auxiliary signals overturn a large safety-score gap', () => {
    const result = selectCandidate([
      makeCandidate({ address: 'pool-safe', safetyScore: 90, auxSignalScore: 0 }),
      makeCandidate({ address: 'pool-hyped', safetyScore: 60, auxSignalScore: 25 })
    ], 'new-token-v1', 0);

    expect(result?.address).toBe('pool-safe');
  });

  it('lets auxiliary signals break close new-token ranking decisions', () => {
    const result = selectCandidate([
      makeCandidate({ address: 'pool-steady', safetyScore: 80, auxSignalScore: 0, feeTvlRatio24h: 0.2 }),
      makeCandidate({ address: 'pool-hot', safetyScore: 70, auxSignalScore: 15, feeTvlRatio24h: 0.01 })
    ], 'new-token-v1', 0);

    expect(result?.address).toBe('pool-hot');
  });

  it('blocks fresh candidates when active position capacity is full', () => {
    const result = selectCandidate([
      makeCandidate({ address: 'fresh-pool', hasInventory: false, safetyScore: 80 }),
      makeCandidate({ address: 'inventory-pool', hasInventory: true, safetyScore: 10 })
    ], 'new-token-v1', 2, 2);

    expect(result?.address).toBe('inventory-pool');
  });

  it('returns null when only fresh candidates remain and active position capacity is full', () => {
    const result = selectCandidate([
      makeCandidate({ address: 'fresh-pool', hasInventory: false, safetyScore: 80, auxSignalScore: 25 })
    ], 'new-token-v1', 2, 2);

    expect(result).toBeNull();
  });

  it('filters fresh candidates for a recently closed mint but keeps inventory management candidates', () => {
    const result = filterRecentlyClosedMintCandidates([
      makeCandidate({ address: 'closed-fresh', mint: 'mint-closed', hasInventory: false, hasLpPosition: false }),
      makeCandidate({ address: 'closed-inventory', mint: 'mint-closed', hasInventory: true, hasLpPosition: false }),
      makeCandidate({ address: 'other-fresh', mint: 'mint-other', hasInventory: false, hasLpPosition: false })
    ], {
      lastClosedMint: 'mint-closed',
      lastClosedAt: '2026-03-22T10:00:00.000Z',
      now: new Date('2026-03-22T10:10:00.000Z')
    });

    expect(result.map((candidate) => candidate.address)).toEqual(['closed-inventory', 'other-fresh']);
  });

  it('falls back to higher liquidity when safety scores are tied', () => {
    const result = selectCandidate([
      makeCandidate({ address: 'pool-a', safetyScore: 80, liquidityUsd: 20_000 }),
      makeCandidate({ address: 'pool-b', safetyScore: 80, liquidityUsd: 30_000 })
    ], 'large-pool-v1', 0);

    expect(result?.address).toBe('pool-b');
  });

  it('applies safety results and fee/tvl bonus without mutating on failure', async () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn()
    };

    const filtered = await applySafetyFilter([
      makeCandidate({ mint: 'mint-safe', feeTvlRatio24h: 0.12 }),
      makeCandidate({ address: 'pool-unsafe', mint: 'mint-unsafe' })
    ], {
      safetyConfig: {
        disabled: false,
        minHolders: 0,
        minBluechipPct: 0,
        minSafetyScore: 50
      },
      maxBatchSize: 50,
      fetchSafety: async () => [
        {
          mint: 'mint-safe',
          safe: true,
          safetyScore: 60,
          maxScore: 120,
          holders: 10,
          bluechipPct: 0.5
        }
      ],
      logger
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.safetyScore).toBe(90);
    expect(logger.log).toHaveBeenCalled();
  });

  it('keeps existing exposure candidates when new-entry safety fetching throws', async () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn()
    };
    const diagnostics = vi.fn();

    const filtered = await applySafetyFilter([
      makeCandidate({ address: 'inventory-pool', mint: 'mint-held', symbol: 'HELD', hasInventory: true }),
      makeCandidate({ address: 'fresh-pool', mint: 'mint-fresh', symbol: 'NEW' })
    ], {
      safetyConfig: {
        disabled: false,
        minHolders: 0,
        minBluechipPct: 0,
        minSafetyScore: 50
      },
      maxBatchSize: 1,
      fetchSafety: async () => {
        throw new Error('gmgn safety outage');
      },
      logger,
      onDiagnostics: diagnostics
    });

    expect(filtered.map((candidate) => candidate.address)).toEqual(['inventory-pool']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed closed for 1 new-entry candidates')
    );
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      checkedMints: ['mint-fresh'],
      rejected: [
        expect.objectContaining({
          symbol: 'NEW',
          mint: 'mint-fresh',
          error: 'gmgn safety outage'
        })
      ]
    }));
  });

  it('fails closed and records rejected diagnostics when safety fetching throws', async () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn()
    };
    const diagnostics = vi.fn();

    const filtered = await applySafetyFilter([
      makeCandidate({ mint: 'mint-risky', symbol: 'RSK' })
    ], {
      safetyConfig: {
        disabled: false,
        minHolders: 0,
        minBluechipPct: 0,
        minSafetyScore: 50
      },
      maxBatchSize: 50,
      fetchSafety: async () => {
        throw new Error('gmgn safety outage');
      },
      logger,
      onDiagnostics: diagnostics
    });

    expect(filtered).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Safety filter failed closed')
    );
    expect(diagnostics).toHaveBeenCalledWith({
      checkedMints: ['mint-risky'],
      results: [
        expect.objectContaining({
          mint: 'mint-risky',
          safe: false,
          safetyScore: 0,
          maxScore: 120,
          error: 'gmgn safety outage'
        })
      ],
      rejected: [
        expect.objectContaining({
          symbol: 'RSK',
          mint: 'mint-risky',
          error: 'gmgn safety outage'
        })
      ]
    });
  });
});
