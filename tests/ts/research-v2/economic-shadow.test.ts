import { describe, expect, it } from 'vitest';

import {
  buildExecutableMarkV2,
  simulateEconomicShadowEpisodeV2,
  simulateEconomicShadowPortfolioV2,
  type OpportunityEpisodeV2
} from '../../../src/research-v2';

function episode(overrides: Partial<OpportunityEpisodeV2> = {}): OpportunityEpisodeV2 {
  return {
    schemaVersion: 2,
    runId: 'run-1',
    strategyId: 'new-token-v1',
    episodeId: 'episode-1',
    tokenMint: 'mint-1',
    tokenSymbol: 'TOK',
    poolAddress: 'pool-1',
    deployerAddress: 'deployer-1',
    configSnapshotId: 'config-1',
    policyVariantId: 'policy-1',
    capturedAt: '2026-07-01T00:00:00.000Z',
    labelWindowEndsAt: '2026-07-02T00:00:00.000Z',
    eligible: true,
    selected: true,
    hardRejectionReasons: [],
    softRejectionReasons: [],
    pointInTimeFeatures: {
      feeTvlRatio24h: 0.03,
      liquidityUsd: 50_000
    },
    sourceObservations: [{
      source: 'chain_fast_safety',
      status: 'passed',
      observedAt: '2026-07-01T00:00:00.000Z',
      freshnessMs: 1_000,
      details: {}
    }],
    ...overrides
  };
}

describe('simulateEconomicShadowEpisodeV2', () => {
  it('counts no-route as a conservative zero-recovery adverse outcome without wallet fill evidence', () => {
    const result = simulateEconomicShadowEpisodeV2({
      episode: episode(),
      positionSizeSol: 0.1,
      feeAccrualSol: 0.001,
      marks: [
        buildExecutableMarkV2({
          episodeId: 'episode-1',
          strategyId: 'new-token-v1',
          tokenMint: 'mint-1',
          poolAddress: 'pool-1',
          horizon: '24h',
          episodeCapturedAt: '2026-07-01T00:00:00.000Z',
          observedAt: '2026-07-02T00:00:00.000Z',
          routeStatus: 'no_route',
          quoteSlot: 100,
          quoteAgeMs: 250
        })
      ]
    });

    expect(result).toMatchObject({
      mode: 'economic-shadow',
      status: 'simulated',
      evidenceType: 'simulated_quote',
      fillEvidenceType: 'simulated_quote',
      terminalMarkStatus: 'adverse',
      terminalRouteStatus: 'no_route',
      exitValueSol: 0,
      noRouteProbability: 1
    });
    expect(result.fillEvidenceType).not.toBe('wallet-delta');
    expect(result.pnl?.principalChangeSol).toBeCloseTo(-0.1, 12);
    expect(result.pnl?.netPnlSol).toBeLessThan(0);
  });

  it('computes after-cost net pnl from fee, IL, impact, chain fee and failed transaction costs', () => {
    const result = simulateEconomicShadowEpisodeV2({
      episode: episode(),
      positionSizeSol: 0.1,
      feeAccrualSol: 0.002,
      impermanentLossSol: 0.001,
      baseFeeLamports: 5_000,
      priorityFeeLamports: 2_000,
      jitoTipLamports: 3_000,
      failedTransactionProbability: 0.5,
      failedTransactionCostSol: 0.002,
      landingLatencyMs: 4_500,
      marks: [
        buildExecutableMarkV2({
          episodeId: 'episode-1',
          strategyId: 'new-token-v1',
          tokenMint: 'mint-1',
          poolAddress: 'pool-1',
          horizon: '24h',
          episodeCapturedAt: '2026-07-01T00:00:00.000Z',
          observedAt: '2026-07-02T00:00:00.000Z',
          routeStatus: 'available',
          executableValueSol: 0.11,
          buyRouteAvailable: true,
          sellRouteAvailable: true,
          quoteSlot: 101,
          quoteAgeMs: 150,
          roundTripImpactBps: 100,
          capacityCurve: [{ inputSol: 0.1, outputSol: 0.099, impactBps: 100 }]
        })
      ]
    });

    expect(result.evidenceType).toBe('simulated_transaction');
    expect(result.pnl?.principalChangeSol).toBeCloseTo(0.01, 12);
    expect(result.pnl?.feeIncomeSol).toBe(0.002);
    expect(result.pnl?.impermanentLossSol).toBe(0.001);
    expect(result.pnl?.roundTripCostSol).toBe(0.001);
    expect(result.pnl?.baseFeeSol).toBe(0.000005);
    expect(result.pnl?.priorityFeeSol).toBe(0.000002);
    expect(result.pnl?.jitoTipSol).toBe(0.000003);
    expect(result.pnl?.failedTransactionExpectedCostSol).toBe(0.001);
    expect(result.pnl?.feeImpermanentLossRatio).toBe(2);
    expect(result.pnl?.grossPnlSol).toBeCloseTo(0.011, 12);
    expect(result.pnl?.netPnlSol).toBeCloseTo(0.00899, 12);
    expect(result.benchmarks.map((entry) => entry.name)).toEqual([
      'no_trade',
      'hold_sol',
      'direct_token',
      'wide_range_lp',
      'current_strategy',
      'candidate_strategy'
    ]);
  });
});

describe('simulateEconomicShadowPortfolioV2', () => {
  it('uses finite capital and active-position risk budgets instead of fabricating unlimited fills', () => {
    const firstEpisode = episode({ episodeId: 'episode-1', tokenMint: 'mint-1', poolAddress: 'pool-1' });
    const secondEpisode = episode({
      episodeId: 'episode-2',
      tokenMint: 'mint-2',
      poolAddress: 'pool-2',
      capturedAt: '2026-07-01T00:01:00.000Z',
      labelWindowEndsAt: '2026-07-02T00:01:00.000Z'
    });
    const result = simulateEconomicShadowPortfolioV2({
      generatedAt: '2026-07-03T00:00:00.000Z',
      account: {
        startingSol: 0.2,
        solReserve: 0.05,
        maxActivePositions: 1,
        maxDailyNewRiskSol: 0.2,
        maxPositionSol: 0.1
      },
      episodes: [
        {
          episode: firstEpisode,
          positionSizeSol: 0.1,
          marks: [
            buildExecutableMarkV2({
              episodeId: 'episode-1',
              strategyId: 'new-token-v1',
              tokenMint: 'mint-1',
              poolAddress: 'pool-1',
              horizon: '24h',
              episodeCapturedAt: firstEpisode.capturedAt,
              observedAt: '2026-07-02T00:00:00.000Z',
              routeStatus: 'available',
              executableValueSol: 0.12,
              buyRouteAvailable: true,
              sellRouteAvailable: true,
              quoteSlot: 200,
              quoteAgeMs: 100,
              roundTripImpactBps: 25,
              capacityCurve: [{ inputSol: 0.1, outputSol: 0.1197, impactBps: 25 }]
            })
          ]
        },
        {
          episode: secondEpisode,
          positionSizeSol: 0.1,
          marks: [
            buildExecutableMarkV2({
              episodeId: 'episode-2',
              strategyId: 'new-token-v1',
              tokenMint: 'mint-2',
              poolAddress: 'pool-2',
              horizon: '24h',
              episodeCapturedAt: secondEpisode.capturedAt,
              observedAt: '2026-07-02T00:01:00.000Z',
              routeStatus: 'available',
              executableValueSol: 0.13,
              buyRouteAvailable: true,
              sellRouteAvailable: true,
              quoteSlot: 201,
              quoteAgeMs: 100,
              roundTripImpactBps: 25,
              capacityCurve: [{ inputSol: 0.1, outputSol: 0.1297, impactBps: 25 }]
            })
          ]
        }
      ]
    });

    expect(result).toMatchObject({
      mode: 'economic-shadow',
      simulatedEpisodeCount: 1,
      skippedEpisodeCount: 1,
      maxActivePositionsObserved: 1
    });
    expect(result.episodes[1]).toMatchObject({
      status: 'skipped',
      skipReason: 'max_active_positions_reached'
    });
    expect(result.dailyNewRiskSol['2026-07-01']).toBeCloseTo(0.1, 12);
    expect(result.endingEquitySol).toBeGreaterThan(result.startingSol);
  });
});
