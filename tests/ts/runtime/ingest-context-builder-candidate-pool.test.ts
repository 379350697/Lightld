import { describe, expect, it, vi } from 'vitest';

import { buildLiveCycleInputFromIngest } from '../../../src/runtime/ingest-context-builder';
import type { IngestCandidate } from '../../../src/runtime/ingest-candidate-selection';
import type { CandidatePoolEntry, CandidatePoolReader } from '../../../src/candidate-pool/types';

function makeCandidate(overrides: Partial<IngestCandidate> = {}): IngestCandidate {
  return {
    address: 'pool-candidate',
    mint: 'mint-candidate',
    symbol: 'CAND',
    quoteMint: 'So11111111111111111111111111111111111111112',
    liquidityUsd: 25_000,
    hasSolRoute: true,
    capturedAt: '2026-06-21T10:00:00.000Z',
    holders: 0,
    hasInventory: false,
    hasLpPosition: false,
    binStep: 120,
    baseFeePct: 1,
    volume24h: 2_000_000,
    feeTvlRatio24h: 0.12,
    auxSignalScore: 0,
    dexscreenerBoostAmount: 0,
    dexscreenerHasProfile: false,
    jupiterOrganicScore: 0,
    jupiterTrendingRank: 0,
    coingeckoTrendingRank: 0,
    auxSignalStatus: 'disabled',
    ...overrides
  };
}

function makeEntry(candidate = makeCandidate()): CandidatePoolEntry {
  return {
    strategyId: 'new-token-v1',
    poolAddress: candidate.address,
    tokenMint: candidate.mint,
    tokenSymbol: candidate.symbol,
    status: 'openable',
    openable: true,
    score: 90,
    blockReason: '',
    freshnessExpiresAt: '2026-06-21T10:01:00.000Z',
    updatedAt: '2026-06-21T10:00:00.000Z',
    candidate
  };
}

describe('buildLiveCycleInputFromIngest candidate pool cutover', () => {
  it('selects an openable candidate from the candidate pool without fetching live ingest sources', async () => {
    const reader: CandidatePoolReader = {
      selectOpenableCandidate: vi.fn(async () => makeEntry())
    };
    const fetchMeteoraPoolsImpl = vi.fn(async () => {
      throw new Error('meteora should not be fetched during candidate pool cutover');
    });

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.02,
      now: new Date('2026-06-21T10:00:00.000Z'),
      candidatePoolReadEnabled: true,
      candidatePoolReader: reader,
      fetchMeteoraPoolsImpl
    });

    expect(fetchMeteoraPoolsImpl).not.toHaveBeenCalled();
    expect(reader.selectOpenableCandidate).toHaveBeenCalledWith('new-token-v1', expect.objectContaining({
      now: new Date('2026-06-21T10:00:00.000Z')
    }));
    expect(result.context.pool).toMatchObject({
      address: 'pool-candidate',
      candidatePoolStatus: 'openable'
    });
    expect(result.context.token).toMatchObject({
      mint: 'mint-candidate',
      symbol: 'CAND'
    });
    expect(result.context.route).toMatchObject({
      hasSolRoute: true,
      poolAddress: 'pool-candidate'
    });
  });

  it('fails closed for new opens when candidate pool is enabled but unavailable', async () => {
    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.02,
      now: new Date('2026-06-21T10:00:00.000Z'),
      candidatePoolReadEnabled: true
    });

    expect(result.context.pool).toMatchObject({
      address: '',
      blockReason: 'candidate-pool-unavailable'
    });
    expect(result.context.route).toMatchObject({
      hasSolRoute: false,
      blockReason: 'candidate-pool-unavailable'
    });
  });

  it('keeps existing LP maintenance independent from the candidate pool', async () => {
    const reader: CandidatePoolReader = {
      selectOpenableCandidate: vi.fn(async () => {
        throw new Error('candidate pool should not be read for existing LP maintenance');
      })
    };

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.02,
      now: new Date('2026-06-21T10:00:00.000Z'),
      candidatePoolReadEnabled: true,
      candidatePoolReader: reader,
      accountState: {
        walletSol: 0.4,
        journalSol: 0.4,
        walletTokens: [],
        journalTokens: [],
        fills: [{
          mint: 'mint-lp',
          symbol: 'LPX',
          side: 'add-lp',
          amount: 0.02,
          recordedAt: '2026-06-21T09:55:00.000Z'
        }],
        journalLpPositions: [],
        walletLpPositions: [{
          poolAddress: 'pool-lp',
          positionAddress: 'position-lp',
          mint: 'mint-lp',
          hasLiquidity: true,
          currentValueSol: 0.021,
          liquidityValueSol: 0.02,
          unclaimedFeeValueSol: 0.001,
          claimedFeeValueSol: 0,
          lpTotalValueSol: 0.021,
          unclaimedFeeSol: 0.001,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete',
          valuationSource: 'meteora-withdraw-simulation'
        }]
      },
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        lifecycleState: 'open',
        activeMint: 'mint-lp',
        activePoolAddress: 'pool-lp',
        positionId: 'position-lp',
        chainPositionAddress: 'position-lp',
        entrySol: 0.02,
        openedAt: '2026-06-21T09:55:00.000Z',
        walletSol: 0.4,
        updatedAt: '2026-06-21T09:56:00.000Z'
      }
    });

    expect(reader.selectOpenableCandidate).not.toHaveBeenCalled();
    expect(result.context.pool).toMatchObject({
      address: 'pool-lp'
    });
    expect(result.context.token).toMatchObject({
      mint: 'mint-lp',
      symbol: 'LPX'
    });
    expect(result.context.trader).toMatchObject({
      hasInventory: true,
      hasLpPosition: true,
      lpCurrentValueSol: 0.021,
      lpTotalValueSol: 0.021,
      valuationStatus: 'ready',
      valuationCompleteness: 'complete'
    });
  });
});
