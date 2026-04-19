import { describe, expect, it } from 'vitest';

import {
  replayParameterProposals,
  type ParameterProposalRecord,
  type PoolDecisionSampleRecord
} from '../../../src/evolution';

describe('replayParameterProposals', () => {
  it('replays a lower min-liquidity proposal against newly admitted blocked samples', () => {
    const proposals: ParameterProposalRecord[] = [
      {
        proposalId: 'parameter:filters.minLiquidityUsd:2026-04-19T15:00:00.000Z',
        proposalKind: 'parameter',
        strategyId: 'new-token-v1',
        status: 'draft',
        createdAt: '2026-04-19T15:00:00.000Z',
        updatedAt: '2026-04-19T15:00:00.000Z',
        targetPath: 'filters.minLiquidityUsd',
        oldValue: 1000,
        proposedValue: 900,
        evidenceWindowHours: 24,
        sampleSize: 5,
        rationale: 'Would admit more breakouts.',
        expectedImprovement: 'Capture missed pools.',
        riskNote: 'Can admit more noise.',
        uncertaintyNote: 'Needs replay.',
        patchable: true
      }
    ];
    const samples: PoolDecisionSampleRecord[] = [
      buildSample({
        sampleId: 'cand-admitted-early',
        blockedReason: 'min-liquidity',
        liquidityUsd: 950,
        capturedAt: '2026-04-19T00:00:00.000Z',
        relativeToSelectedBaselineSol: 0.18,
        relativeToSelectedBaselineByWindowLabel: {
          '15m': 0.08,
          '1h': 0.24,
          '4h': 0.18
        }
      }),
      buildSample({
        sampleId: 'cand-admitted-late',
        blockedReason: 'min-liquidity',
        liquidityUsd: 975,
        capturedAt: '2026-04-19T03:00:00.000Z',
        relativeToSelectedBaselineSol: 0.12,
        relativeToSelectedBaselineByWindowLabel: {
          '15m': 0.04,
          '1h': 0.16,
          '4h': 0.12,
          '24h': 0.06
        }
      }),
      buildSample({
        sampleId: 'cand-still-blocked',
        blockedReason: 'min-liquidity',
        liquidityUsd: 820,
        relativeToSelectedBaselineSol: 0.41,
        relativeToSelectedBaselineByWindowLabel: {
          '1h': 0.41
        }
      }),
      buildSample({
        sampleId: 'cand-selected',
        blockedReason: '',
        liquidityUsd: 2_500,
        selected: true,
        relativeToSelectedBaselineSol: 0,
        relativeToSelectedBaselineByWindowLabel: {
          '1h': 0,
          '4h': 0
        }
      })
    ];

    const result = replayParameterProposals({
      proposals,
      samples
    });

    expect(result).toEqual([
      expect.objectContaining({
        proposalId: proposals[0].proposalId,
        targetPath: 'filters.minLiquidityUsd',
        admittedSampleCount: 2,
        positiveRelativeSamples: 2,
        averageRelativeToSelectedBaselineSol: 0.15,
        windowSummaries: [
          expect.objectContaining({
            windowLabel: '15m',
            sampleCount: 2,
            averageRelativeToSelectedBaselineSol: 0.06
          }),
          expect.objectContaining({
            windowLabel: '1h',
            sampleCount: 2,
            averageRelativeToSelectedBaselineSol: 0.2
          }),
          expect.objectContaining({
            windowLabel: '4h',
            sampleCount: 2,
            averageRelativeToSelectedBaselineSol: 0.15
          }),
          expect.objectContaining({
            windowLabel: '24h',
            sampleCount: 1,
            averageRelativeToSelectedBaselineSol: 0.06
          })
        ],
        sliceSummaries: [
          expect.objectContaining({
            sliceLabel: 'earlier-half',
            sampleCount: 1,
            averageRelativeToSelectedBaselineSol: 0.18
          }),
          expect.objectContaining({
            sliceLabel: 'later-half',
            sampleCount: 1,
            averageRelativeToSelectedBaselineSol: 0.12
          })
        ]
      })
    ]);
  });

  it('returns an empty replay when the proposal direction would not newly admit any blocked samples', () => {
    const result = replayParameterProposals({
      proposals: [
        {
          proposalId: 'parameter:lpConfig.minBinStep:2026-04-19T16:00:00.000Z',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-19T16:00:00.000Z',
          updatedAt: '2026-04-19T16:00:00.000Z',
          targetPath: 'lpConfig.minBinStep',
          oldValue: 100,
          proposedValue: 110,
          evidenceWindowHours: 24,
          sampleSize: 3,
          rationale: 'Tighter floor.',
          expectedImprovement: 'Avoid weak pools.',
          riskNote: 'Could miss winners.',
          uncertaintyNote: 'Needs replay.',
          patchable: true
        }
      ],
      samples: [
        buildSample({
          sampleId: 'cand-bin',
          blockedReason: 'min-bin-step',
          binStep: 95,
          relativeToSelectedBaselineSol: 0.22,
          relativeToSelectedBaselineByWindowLabel: {
            '1h': 0.22
          }
        })
      ]
    });

    expect(result).toEqual([
      expect.objectContaining({
        targetPath: 'lpConfig.minBinStep',
        admittedSampleCount: 0,
        averageRelativeToSelectedBaselineSol: null
      })
    ]);
  });
});

function buildSample(input: {
  sampleId: string;
  blockedReason: string;
  liquidityUsd?: number;
  binStep?: number;
  selected?: boolean;
  capturedAt?: string;
  relativeToSelectedBaselineSol: number | null;
  relativeToSelectedBaselineByWindowLabel: Record<string, number | null>;
}): PoolDecisionSampleRecord {
  return {
    sampleId: input.sampleId,
    strategyId: 'new-token-v1',
    cycleId: `cycle-${input.sampleId}`,
    capturedAt: input.capturedAt ?? '2026-04-19T00:00:00.000Z',
    tokenMint: `mint-${input.sampleId}`,
    tokenSymbol: input.sampleId.toUpperCase(),
    poolAddress: `pool-${input.sampleId}`,
    decision: {
      selected: input.selected ?? false,
      selectionRank: input.selected ? 1 : 2,
      blockedReason: input.blockedReason,
      rejectionStage: input.selected ? 'none' : 'selection',
      runtimeMode: 'healthy',
      sessionPhase: 'active'
    },
    candidateFeatures: {
      liquidityUsd: input.liquidityUsd ?? 1000,
      holders: 50,
      safetyScore: 80,
      volume24h: 5000,
      feeTvlRatio24h: 0.1,
      binStep: input.binStep ?? 120,
      hasInventory: false,
      hasLpPosition: false
    },
    futurePath: {
      observationCount: Object.keys(input.relativeToSelectedBaselineByWindowLabel).length,
      latestWindowLabel: Object.keys(input.relativeToSelectedBaselineByWindowLabel).at(-1) ?? null,
      latestValueSol: 0.3,
      maxObservedValueSol: 0.4,
      minObservedValueSol: 0.2,
      bestWindowLabel: Object.keys(input.relativeToSelectedBaselineByWindowLabel)[0] ?? null,
      bestWindowValueSol: 0.4,
      forwardValueByWindowLabel: Object.fromEntries(
        Object.keys(input.relativeToSelectedBaselineByWindowLabel).map((windowLabel) => [windowLabel, 0.3])
      ),
      latestLiquidityUsd: input.liquidityUsd ?? 1000,
      hasInventoryFollowThrough: false,
      hasLpPositionFollowThrough: false,
      outcomeCount: 0,
      latestOutcomeReason: null,
      latestExitMetricValue: null
    },
    counterfactual: {
      selectedBaselineValueSol: 0.2,
      selectedBaselineValueByWindowLabel: Object.fromEntries(
        Object.keys(input.relativeToSelectedBaselineByWindowLabel).map((windowLabel) => [windowLabel, 0.2])
      ),
      relativeToSelectedBaselineSol: input.relativeToSelectedBaselineSol,
      relativeToSelectedBaselineByWindowLabel: input.relativeToSelectedBaselineByWindowLabel,
      bestRelativeWindowLabel: Object.keys(input.relativeToSelectedBaselineByWindowLabel)[0] ?? null,
      bestRelativeWindowValueSol: input.relativeToSelectedBaselineSol,
      outperformedSelectedBaseline:
        typeof input.relativeToSelectedBaselineSol === 'number'
          ? input.relativeToSelectedBaselineSol > 0
          : null
    }
  };
}
