import { describe, expect, it } from 'vitest';

import {
  blockBootstrapGeometricReturnV2,
  buildValidationCoverageV2,
  buildValidationMetricObservationsFromEconomicShadowV2,
  buildValidationMetricsV2,
  geometricMeanReturn
} from '../../../src/research-v2';

describe('research-v2 statistics', () => {
  it('computes coverage using independent episodes and concentration by pool/deployer', () => {
    const coverage = buildValidationCoverageV2([
      {
        episodeId: 'episode-1',
        capturedAt: '2026-07-01T00:00:00.000Z',
        poolAddress: 'pool-a',
        deployerAddress: 'deployer-a',
        marketRegime: 'risk-on',
        netPnlSol: 0.04
      },
      {
        episodeId: 'episode-2',
        capturedAt: '2026-07-01T01:00:00.000Z',
        poolAddress: 'pool-a',
        deployerAddress: 'deployer-a',
        marketRegime: 'risk-on',
        netPnlSol: 0.01
      },
      {
        episodeId: 'episode-3',
        capturedAt: '2026-07-02T00:00:00.000Z',
        poolAddress: 'pool-b',
        deployerAddress: 'deployer-b',
        marketRegime: 'risk-off',
        netPnlSol: 0.05
      },
      {
        episodeId: 'episode-3',
        capturedAt: '2026-07-02T00:00:00.000Z',
        poolAddress: 'pool-b',
        deployerAddress: 'deployer-b',
        marketRegime: 'risk-off',
        netPnlSol: 0.05
      }
    ], ['episode-2', 'episode-3']);

    expect(coverage).toMatchObject({
      independentEpisodes: 3,
      naturalDays: 2,
      untouchedOosEpisodes: 2,
      marketRegimes: 2,
      maxPoolEpisodeContributionPct: 2 / 3 * 100,
      maxPoolProfitContributionPct: 50,
      maxDeployerEpisodeContributionPct: 2 / 3 * 100
    });
  });

  it('computes geometric returns conservatively when an episode loses all capital', () => {
    expect(geometricMeanReturn([0.1, -1, 0.2])).toBe(-1);
    expect(geometricMeanReturn([0.1, -0.1])).toBeCloseTo(Math.sqrt(0.99) - 1, 12);
  });

  it('runs deterministic cluster/block bootstrap lower and upper confidence bounds', () => {
    const result = blockBootstrapGeometricReturnV2({
      iterations: 200,
      seed: 42,
      observations: [
        { episodeId: 'episode-1', blockKey: '2026-07-01:pool-a:deployer-a', afterCostReturn: 0.04 },
        { episodeId: 'episode-2', blockKey: '2026-07-01:pool-a:deployer-a', afterCostReturn: 0.02 },
        { episodeId: 'episode-3', blockKey: '2026-07-02:pool-b:deployer-b', afterCostReturn: -0.01 },
        { episodeId: 'episode-4', blockKey: '2026-07-03:pool-c:deployer-c', afterCostReturn: 0.03 }
      ]
    });
    const repeated = blockBootstrapGeometricReturnV2({
      iterations: 200,
      seed: 42,
      observations: [
        { episodeId: 'episode-1', blockKey: '2026-07-01:pool-a:deployer-a', afterCostReturn: 0.04 },
        { episodeId: 'episode-2', blockKey: '2026-07-01:pool-a:deployer-a', afterCostReturn: 0.02 },
        { episodeId: 'episode-3', blockKey: '2026-07-02:pool-b:deployer-b', afterCostReturn: -0.01 },
        { episodeId: 'episode-4', blockKey: '2026-07-03:pool-c:deployer-c', afterCostReturn: 0.03 }
      ]
    });

    expect(result).toEqual(repeated);
    expect(result).toMatchObject({
      schemaVersion: 2,
      method: 'cluster_block_bootstrap_v2',
      iterationCount: 200,
      blockCount: 3,
      observationCount: 4
    });
    expect(result.lower95GeometricReturn).toBeLessThanOrEqual(result.observedGeometricReturn);
    expect(result.upper95GeometricReturn).toBeGreaterThanOrEqual(result.observedGeometricReturn);
  });

  it('derives validation metrics from independent after-cost episode returns', () => {
    const metrics = buildValidationMetricsV2({
      observations: [
        { episodeId: 'episode-1', marketRegime: 'risk-on', afterCostReturn: 0.10, baselineAfterCostReturn: 0 },
        { episodeId: 'episode-2', marketRegime: 'risk-on', afterCostReturn: -0.05, baselineAfterCostReturn: -0.04 },
        { episodeId: 'episode-3', marketRegime: 'risk-off', afterCostReturn: 0.04, baselineAfterCostReturn: 0.01 },
        { episodeId: 'episode-4', marketRegime: 'risk-off', afterCostReturn: -0.02, baselineAfterCostReturn: -0.01 },
        { episodeId: 'episode-5', marketRegime: 'risk-off', afterCostReturn: 0.03, baselineAfterCostReturn: 0.02 }
      ],
      trimPct: 0.2,
      oosGeometricReturnLower95: 0.001,
      deflatedSharpePValue: 0.04,
      probabilityOfBacktestOverfitting: 0.1,
      hansenSpaPValue: 0.03,
      bhFdrQValue: 0.04,
      capacityDecayAtDoubleSizePct: 0.12,
      targetSizeExitExecutable: true,
      doubleSizeExitExecutable: true
    });

    expect(metrics.afterCostArithmeticReturn).toBeCloseTo(0.02, 12);
    expect(metrics.medianReturn).toBeCloseTo(0.03, 12);
    expect(metrics.trimmedMeanReturn).toBeCloseTo((-0.02 + 0.03 + 0.04) / 3, 12);
    expect(metrics.profitFactor).toBeCloseTo(0.17 / 0.07, 12);
    expect(metrics.candidateExpectedShortfall95).toBeCloseTo(0.05, 12);
    expect(metrics.candidateExpectedShortfall99).toBeCloseTo(0.05, 12);
    expect(metrics.candidateMaxDrawdownPct).toBeCloseTo(0.05, 12);
    expect(metrics.baselineMaxDrawdownPct).toBeGreaterThan(0.04);
    expect(metrics.lossClusteringScore).toBeCloseTo(0.2, 12);
    expect(metrics.regimeDirectionConsistent).toBe(true);
    expect(metrics.targetSizeExitExecutable).toBe(true);
    expect(metrics.doubleSizeExitExecutable).toBe(true);
  });

  it('extracts validation observations directly from economic-shadow portfolio results', () => {
    const observations = buildValidationMetricObservationsFromEconomicShadowV2({
      schemaVersion: 2,
      mode: 'economic-shadow',
      generatedAt: '2026-07-10T00:00:00.000Z',
      startingSol: 1,
      endingEquitySol: 1.01,
      totalNetPnlSol: 0.01,
      simulatedEpisodeCount: 1,
      skippedEpisodeCount: 1,
      maxActivePositionsObserved: 1,
      dailyNewRiskSol: { '2026-07-10': 0.1 },
      noRouteProbability: 0,
      episodes: [
        {
          schemaVersion: 2,
          simulationId: 'sim-1',
          mode: 'economic-shadow',
          episodeId: 'episode-1',
          strategyId: 'new-token-v1',
          tokenMint: 'mint-1',
          poolAddress: 'pool-1',
          selected: true,
          status: 'simulated',
          evidenceType: 'simulated_transaction',
          fillEvidenceType: 'simulated_transaction',
          terminalHorizon: '24h',
          terminalMarkId: 'mark-1',
          terminalMarkStatus: 'observed',
          terminalRouteStatus: 'available',
          positionSizeSol: 0.1,
          exitValueSol: 0.112,
          quoteAgeMs: 100,
          landingLatencyMs: 500,
          noRouteProbability: 0,
          timeInRangePct: 1,
          mfeSol: 0.02,
          maeSol: -0.005,
          capacityCurve: [{ inputSol: 0.1, outputSol: 0.098, impactBps: 50 }],
          pnl: {
            principalChangeSol: 0.012,
            feeIncomeSol: 0,
            inventoryConversionSol: 0,
            impermanentLossSol: 0,
            roundTripCostSol: 0.001,
            baseFeeSol: 0.000005,
            priorityFeeSol: 0,
            jitoTipSol: 0,
            rentSol: 0,
            failedTransactionExpectedCostSol: 0,
            residualLiquidationImpactSol: 0,
            grossPnlSol: 0.012,
            netPnlSol: 0.010995,
            afterCostReturnPct: 0.10995,
            feeImpermanentLossRatio: null
          },
          benchmarks: [
            { name: 'hold_sol', terminalValueSol: 0.1, netPnlSol: 0, afterCostReturnPct: 0 },
            { name: 'direct_token', terminalValueSol: 0.105, netPnlSol: 0.005, afterCostReturnPct: 0.05 }
          ]
        },
        {
          schemaVersion: 2,
          simulationId: 'sim-skipped',
          mode: 'economic-shadow',
          episodeId: 'episode-skipped',
          strategyId: 'new-token-v1',
          tokenMint: 'mint-2',
          poolAddress: 'pool-2',
          selected: false,
          status: 'skipped',
          skipReason: 'not_selected',
          evidenceType: 'simulated_quote',
          fillEvidenceType: 'simulated_quote',
          terminalHorizon: '24h',
          terminalMarkId: null,
          terminalMarkStatus: null,
          terminalRouteStatus: null,
          positionSizeSol: 0.1,
          exitValueSol: null,
          quoteAgeMs: null,
          landingLatencyMs: null,
          noRouteProbability: 0,
          timeInRangePct: null,
          mfeSol: null,
          maeSol: null,
          capacityCurve: [],
          pnl: null,
          benchmarks: []
        }
      ]
    }, 'direct_token');

    expect(observations).toEqual([{
      episodeId: 'episode-1',
      afterCostReturn: 0.10995,
      baselineAfterCostReturn: 0.05
    }]);
  });
});
