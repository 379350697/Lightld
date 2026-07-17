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
    capturedAt: '2026-06-21T07:00:00.000Z',
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
      listOpenableCandidates: vi.fn(async () => [makeEntry()]),
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
    expect(reader.listOpenableCandidates).toHaveBeenCalledWith('new-token-v1', expect.objectContaining({
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

  it('can disable dynamic position sizing for paper sampling', async () => {
    const reader: CandidatePoolReader = {
      listOpenableCandidates: vi.fn(async () => [makeEntry(makeCandidate({ liquidityUsd: 25_000 }))]),
      selectOpenableCandidate: vi.fn(async () => makeEntry(makeCandidate({ liquidityUsd: 25_000 })))
    };

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 1,
      disableDynamicPositionSizing: true,
      now: new Date('2026-06-21T10:00:00.000Z'),
      candidatePoolReadEnabled: true,
      candidatePoolReader: reader
    });

    expect(result.requestedPositionSol).toBe(1);
    expect(result.context.token?.expectedOutSol).toBe(1);
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

  it('does not reopen or maintain a manual wallet LP returned by a stale candidate reader', async () => {
    const manualEntry = makeEntry(makeCandidate({
      address: 'pool-manual',
      mint: 'mint-manual',
      symbol: 'MANUAL'
    }));
    const reader: CandidatePoolReader = {
      listOpenableCandidates: vi.fn(async () => [manualEntry]),
      selectOpenableCandidate: vi.fn(async () => manualEntry)
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
        fills: [],
        journalLpPositions: [],
        walletLpPositions: [{
          poolAddress: 'pool-manual',
          positionAddress: 'position-manual',
          mint: 'mint-manual',
          hasLiquidity: true
        }]
      }
    });

    expect(reader.listOpenableCandidates).toHaveBeenCalledWith('new-token-v1', expect.objectContaining({
      excludedMints: expect.arrayContaining(['mint-manual'])
    }));
    expect(result.context.pool).toMatchObject({
      address: '',
      blockReason: 'candidate-pool-no-openable-candidate'
    });
  });

  it('keeps existing LP maintenance independent from the candidate pool', async () => {
    const reader: CandidatePoolReader = {
      listOpenableCandidates: vi.fn(async () => {
        throw new Error('candidate pool should not be read for existing LP maintenance');
      }),
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
        openIntentId: 'lp-open-intent:position-lp',
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

    expect(reader.listOpenableCandidates).not.toHaveBeenCalled();
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

  it('selects a fresh new-open candidate while excluding active exposure mints', async () => {
    const reader: CandidatePoolReader = {
      listOpenableCandidates: vi.fn(async () => [makeEntry(makeCandidate({
        address: 'pool-next',
        mint: 'mint-next',
        symbol: 'NEXT'
      }))]),
      selectOpenableCandidate: vi.fn(async () => makeEntry(makeCandidate({
        address: 'pool-next',
        mint: 'mint-next',
        symbol: 'NEXT'
      })))
    };

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.02,
      now: new Date('2026-06-21T10:00:00.000Z'),
      candidatePoolReadEnabled: true,
      candidatePoolReader: reader,
      selectionMode: 'new-open-only',
      skipMints: ['mint-explicit-skip'],
      openCooldowns: [{
        poolAddress: 'pool-cooldown',
        tokenMint: 'mint-cooldown',
        reason: 'lp-stop-loss',
        cooldownUntil: '2026-06-21T10:59:00.000Z',
        lastFailedAt: '2026-06-21T10:00:00.000Z',
        updatedAt: '2026-06-21T10:00:00.000Z'
      }],
      accountState: {
        walletSol: 0.4,
        journalSol: 0.4,
        walletTokens: [{ mint: 'mint-wallet-token', amount: 1, currentValueSol: 0.01 }],
        journalTokens: [],
        fills: [],
        journalLpPositions: [],
        walletLpPositions: [{
          poolAddress: 'pool-lp',
          positionAddress: 'position-lp',
          mint: 'mint-lp',
          hasLiquidity: true,
          valuationStatus: 'ready',
          valuationCompleteness: 'complete'
        }]
      },
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'hold',
        lifecycleState: 'open',
        activeMint: 'mint-lp',
        activePoolAddress: 'pool-lp',
        updatedAt: '2026-06-21T09:56:00.000Z'
      }
    });

    expect(reader.listOpenableCandidates).toHaveBeenCalledWith('new-token-v1', expect.objectContaining({
      excludedMints: expect.arrayContaining(['mint-lp', 'mint-wallet-token', 'mint-explicit-skip']),
      excludedTargets: expect.arrayContaining([{ poolAddress: 'pool-cooldown', tokenMint: 'mint-cooldown' }])
    }));
    expect(result.context.token).toMatchObject({
      mint: 'mint-next',
      symbol: 'NEXT'
    });
    expect(result.context.trader).toMatchObject({
      hasInventory: false,
      hasLpPosition: false
    });
  });

  it('does not open from a maintenance-only pass when there is no active LP', async () => {
    const reader: CandidatePoolReader = {
      listOpenableCandidates: vi.fn(async () => [makeEntry()]),
      selectOpenableCandidate: vi.fn(async () => makeEntry())
    };

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.02,
      now: new Date('2026-06-21T10:00:00.000Z'),
      candidatePoolReadEnabled: true,
      candidatePoolReader: reader,
      selectionMode: 'maintenance-only',
      accountState: {
        walletSol: 0.4,
        journalSol: 0.4,
        walletTokens: [],
        journalTokens: [],
        fills: [],
        journalLpPositions: [],
        walletLpPositions: []
      }
    });

    expect(reader.listOpenableCandidates).not.toHaveBeenCalled();
    expect(result.context.route).toMatchObject({
      hasSolRoute: false,
      blockReason: 'no-active-lp-maintenance-target'
    });
  });

  it('skips a higher-ranked candidate that fails strategy gates and opens the next eligible one', async () => {
    const tooYoung = makeEntry(makeCandidate({
      address: 'pool-too-young',
      mint: 'mint-too-young',
      capturedAt: '2026-06-21T09:59:00.000Z'
    }));
    const eligible = makeEntry(makeCandidate({
      address: 'pool-eligible',
      mint: 'mint-eligible',
      symbol: 'ELIG',
      capturedAt: '2026-06-21T07:00:00.000Z'
    }));
    const reader: CandidatePoolReader = {
      listOpenableCandidates: vi.fn(async () => [tooYoung, eligible]),
      selectOpenableCandidate: vi.fn(async () => tooYoung)
    };

    const result = await buildLiveCycleInputFromIngest({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.02,
      disableDynamicPositionSizing: true,
      now: new Date('2026-06-21T10:00:00.000Z'),
      candidatePoolReadEnabled: true,
      candidatePoolReader: reader
    });

    expect(result.context.pool).toMatchObject({
      address: 'pool-eligible',
      candidateCount: 2
    });
    expect(result.context.token).toMatchObject({ mint: 'mint-eligible', symbol: 'ELIG' });
  });
});
