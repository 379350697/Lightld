import { describe, expect, it, vi } from 'vitest';

import type { StrategyConfig } from '../../../src/config/schema';
import {
  applySafetyFilter,
  countActiveInventoryPositions,
  filterLpEligibleCandidates,
  isInScanWindow,
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
    momentum: 50,
    hasInventory: false,
    hasLpPosition: false,
    score: 80,
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
      minBinStep: 100,
      minVolume24hUsd: 1_000_000,
      minFeeTvlRatio24h: 0,
      rebalanceOnOutOfRange: false
    },
    hardGates: {
      requireSolRoute: true,
      minLiquidityUsd: 1000
    },
    filters: {
      minHolders: 0,
      minLiquidityUsd: 1000
    },
    scoringWeights: {
      holders: 0,
      liquidity: 0.5,
      momentum: 0.5
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
      minDeployScore: 70,
      maxHoldHours: 10,
      requireMintAuthorityRevoked: false
    }
  };
}

describe('ingest candidate helpers', () => {
  it('counts active non-SOL inventory positions and Meteora LP positions', () => {
    expect(countActiveInventoryPositions({
      walletSol: 1,
      journalSol: 1,
      walletLpPositions: [
        { poolAddress: 'pool-lp', positionAddress: 'pos-1', mint: 'mint-lp' }
      ],
      journalLpPositions: [],
      walletTokens: [
        { mint: 'mint-a', symbol: 'AAA', amount: 1 },
        { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', amount: 2 },
        { mint: 'mint-b', symbol: 'BBB', amount: 0 }
      ],
      journalTokens: [],
      fills: []
    })).toBe(2);
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

  it('prefers inventory and higher safety candidates when selecting', () => {
    const result = selectCandidate([
      makeCandidate({ address: 'pool-a', hasInventory: false, safetyScore: 80 }),
      makeCandidate({ address: 'pool-b', hasInventory: true, safetyScore: 10 })
    ], 'new-token-v1', true, 0);

    expect(result?.address).toBe('pool-b');
  });

  it('still selects a fresh candidate outside the old scan window when position capacity is available', () => {
    const result = selectCandidate([
      makeCandidate({ address: 'pool-a', hasInventory: false, safetyScore: 80 }),
      makeCandidate({ address: 'pool-b', hasInventory: false, safetyScore: 70 })
    ], 'new-token-v1', false, 0);

    expect(result?.address).toBe('pool-a');
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
});
