import { describe, expect, it } from 'vitest';

import {
  analyzeCounterfactualSamples,
  type PoolDecisionSampleRecord
} from '../../../src/evolution';

describe('analyzeCounterfactualSamples', () => {
  it('summarizes blocked candidates by parameter path using baseline-relative outcomes', () => {
    const samples: PoolDecisionSampleRecord[] = [
      buildSample({
        sampleId: 'cand-liq-1',
        tokenMint: 'mint-liq-1',
        blockedReason: 'min-liquidity',
        relativeToSelectedBaselineSol: 0.32,
        bestWindowLabel: '1h',
        latestValueSol: 0.7,
        bestWindowValueSol: 0.82,
        relativeToSelectedBaselineByWindowLabel: {
          '1h': 0.32,
          '4h': 0.17
        }
      }),
      buildSample({
        sampleId: 'cand-liq-2',
        tokenMint: 'mint-liq-2',
        blockedReason: 'min-liquidity',
        relativeToSelectedBaselineSol: -0.08,
        bestWindowLabel: '4h',
        latestValueSol: 0.11,
        bestWindowValueSol: 0.14,
        relativeToSelectedBaselineByWindowLabel: {
          '1h': -0.08,
          '4h': -0.08
        }
      }),
      buildSample({
        sampleId: 'cand-bin-1',
        tokenMint: 'mint-bin-1',
        blockedReason: 'min-bin-step',
        relativeToSelectedBaselineSol: 0.18,
        bestWindowLabel: '24h',
        latestValueSol: 0.39,
        bestWindowValueSol: 0.48,
        relativeToSelectedBaselineByWindowLabel: {
          '1h': 0.18,
          '24h': 0.24
        }
      }),
      buildSample({
        sampleId: 'cand-selected',
        tokenMint: 'mint-selected',
        selected: true,
        blockedReason: '',
        relativeToSelectedBaselineSol: null,
        bestWindowLabel: '1h',
        latestValueSol: 0.21,
        bestWindowValueSol: 0.21
      })
    ];

    const result = analyzeCounterfactualSamples({
      samples,
      minimumSampleSize: 1
    });

    expect(result.summary).toEqual({
      totalSamples: 4,
      eligibleCounterfactualSamples: 3,
      positiveRelativeSamples: 2
    });
    expect(result.pathSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        blockedReason: 'min-liquidity',
        sampleCount: 2,
        outperformCount: 1,
        outperformRate: 0.5,
        averageRelativeToSelectedBaselineSol: 0.12,
        windowSummaries: [
          expect.objectContaining({
            windowLabel: '1h',
            sampleCount: 2,
            outperformRate: 0.5,
            averageRelativeToSelectedBaselineSol: 0.12
          }),
          expect.objectContaining({
            windowLabel: '4h',
            sampleCount: 2,
            outperformRate: 0.5,
            averageRelativeToSelectedBaselineSol: 0.045
          })
        ],
        sliceSummaries: [
          expect.objectContaining({
            sliceLabel: 'earlier-half',
            sampleCount: 1,
            outperformRate: 1,
            averageRelativeToSelectedBaselineSol: 0.32
          }),
          expect.objectContaining({
            sliceLabel: 'later-half',
            sampleCount: 1,
            outperformRate: 0,
            averageRelativeToSelectedBaselineSol: -0.08
          })
        ]
      }),
      expect.objectContaining({
        targetPath: 'lpConfig.minBinStep',
        blockedReason: 'min-bin-step',
        sampleCount: 1,
        outperformCount: 1,
        outperformRate: 1,
        averageRelativeToSelectedBaselineSol: 0.18,
        windowSummaries: [
          expect.objectContaining({
            windowLabel: '1h',
            sampleCount: 1,
            outperformRate: 1,
            averageRelativeToSelectedBaselineSol: 0.18
          }),
          expect.objectContaining({
            windowLabel: '24h',
            sampleCount: 1,
            outperformRate: 1,
            averageRelativeToSelectedBaselineSol: 0.24
          })
        ],
        sliceSummaries: [
          expect.objectContaining({
            sliceLabel: 'all-observed',
            sampleCount: 1,
            outperformRate: 1,
            averageRelativeToSelectedBaselineSol: 0.18
          })
        ]
      })
    ]));
    expect(result.noActionReasons).toEqual([]);
  });

  it('reports insufficient evidence when no blocked counterfactual samples are available', () => {
    const result = analyzeCounterfactualSamples({
      samples: [
        buildSample({
          sampleId: 'cand-selected-only',
          tokenMint: 'mint-selected-only',
          selected: true,
          blockedReason: '',
          relativeToSelectedBaselineSol: null
        })
      ],
      minimumSampleSize: 2
    });

    expect(result.summary).toEqual({
      totalSamples: 1,
      eligibleCounterfactualSamples: 0,
      positiveRelativeSamples: 0
    });
    expect(result.pathSummaries).toEqual([]);
    expect(result.noActionReasons).toEqual(expect.arrayContaining([
      'insufficient_sample_size',
      'data_coverage_gaps'
    ]));
  });
});

function buildSample(input: {
  sampleId: string;
  tokenMint: string;
  selected?: boolean;
  blockedReason: string;
  relativeToSelectedBaselineSol: number | null;
  bestWindowLabel?: string | null;
  latestValueSol?: number | null;
  bestWindowValueSol?: number | null;
  relativeToSelectedBaselineByWindowLabel?: Record<string, number | null>;
}): PoolDecisionSampleRecord {
  return {
    sampleId: input.sampleId,
    strategyId: 'new-token-v1',
    cycleId: `cycle-${input.sampleId}`,
    capturedAt: '2026-04-18T00:00:00.000Z',
    tokenMint: input.tokenMint,
    tokenSymbol: input.tokenMint.toUpperCase(),
    poolAddress: `pool-${input.tokenMint}`,
    decision: {
      selected: input.selected ?? false,
      selectionRank: input.selected ? 1 : 2,
      blockedReason: input.blockedReason,
      rejectionStage: input.selected ? 'none' : 'selection',
      runtimeMode: 'healthy',
      sessionPhase: 'active'
    },
    candidateFeatures: {
      liquidityUsd: 1000,
      holders: 50,
      safetyScore: 80,
      volume24h: 5000,
      feeTvlRatio24h: 0.1,
      binStep: 120,
      hasInventory: false,
      hasLpPosition: false
    },
    futurePath: {
      observationCount: 1,
      latestWindowLabel: input.bestWindowLabel ?? null,
      latestValueSol: input.latestValueSol ?? null,
      maxObservedValueSol: input.bestWindowValueSol ?? input.latestValueSol ?? null,
      minObservedValueSol: input.latestValueSol ?? null,
      bestWindowLabel: input.bestWindowLabel ?? null,
      bestWindowValueSol: input.bestWindowValueSol ?? input.latestValueSol ?? null,
      forwardValueByWindowLabel: Object.fromEntries(
        Object.keys(input.relativeToSelectedBaselineByWindowLabel ?? {}).map((windowLabel) => [
          windowLabel,
          input.bestWindowLabel === windowLabel
            ? (input.bestWindowValueSol ?? input.latestValueSol ?? null)
            : input.latestValueSol ?? null
        ])
      ),
      latestLiquidityUsd: 1200,
      hasInventoryFollowThrough: false,
      hasLpPositionFollowThrough: false,
      outcomeCount: 0,
      latestOutcomeReason: null,
      latestExitMetricValue: null
    },
    counterfactual: {
      selectedBaselineValueSol: 0.2,
      relativeToSelectedBaselineSol: input.relativeToSelectedBaselineSol,
      selectedBaselineValueByWindowLabel: {
        ...Object.fromEntries(
          Object.keys(input.relativeToSelectedBaselineByWindowLabel ?? {}).map((windowLabel) => [windowLabel, 0.2])
        )
      },
      relativeToSelectedBaselineByWindowLabel: input.relativeToSelectedBaselineByWindowLabel ?? {},
      bestRelativeWindowLabel: input.bestWindowLabel ?? null,
      bestRelativeWindowValueSol:
        input.relativeToSelectedBaselineByWindowLabel?.[input.bestWindowLabel ?? ''] ?? input.relativeToSelectedBaselineSol,
      outperformedSelectedBaseline:
        typeof input.relativeToSelectedBaselineSol === 'number'
          ? input.relativeToSelectedBaselineSol > 0
          : null
    }
  };
}
