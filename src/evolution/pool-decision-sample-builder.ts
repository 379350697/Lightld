import type {
  CandidateScanRecord,
  LiveCycleOutcomeRecord,
  PoolDecisionSampleRecord,
  WatchlistSnapshotRecord
} from './types.ts';

export type BuildPoolDecisionSamplesInput = {
  candidateScans: CandidateScanRecord[];
  watchlistSnapshots: WatchlistSnapshotRecord[];
  outcomes: LiveCycleOutcomeRecord[];
};

export function buildPoolDecisionSamples(input: BuildPoolDecisionSamplesInput): PoolDecisionSampleRecord[] {
  return input.candidateScans.flatMap((scan) => {
    const selectedBaselineValueSol = computeSelectedBaseline(scan, input.watchlistSnapshots);

    return scan.candidates.map((candidate) => {
      const snapshots = input.watchlistSnapshots
        .filter((snapshot) =>
          snapshot.tokenMint === candidate.tokenMint
          && snapshot.poolAddress === candidate.poolAddress
          && Date.parse(snapshot.observationAt) >= Date.parse(candidate.capturedAt)
        )
        .sort((left, right) => left.observationAt.localeCompare(right.observationAt));
      const latestSnapshot = snapshots[snapshots.length - 1];
      const outcomes = input.outcomes
        .filter((outcome) =>
          outcome.tokenMint === candidate.tokenMint
          && outcome.poolAddress === candidate.poolAddress
          && Date.parse(outcome.recordedAt) >= Date.parse(candidate.capturedAt)
        )
        .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
      const latestOutcome = outcomes[outcomes.length - 1];
      const observedValues = snapshots
        .map((snapshot) => snapshot.currentValueSol)
        .filter((value): value is number => typeof value === 'number');
      const latestValueSol = typeof latestSnapshot?.currentValueSol === 'number'
        ? latestSnapshot.currentValueSol
        : null;
      const relativeToSelectedBaselineSol =
        typeof selectedBaselineValueSol === 'number' && typeof latestValueSol === 'number'
          ? roundMetric(latestValueSol - selectedBaselineValueSol)
          : null;

      return {
        sampleId: candidate.sampleId,
        strategyId: candidate.strategyId,
        cycleId: candidate.cycleId,
        capturedAt: candidate.capturedAt,
        tokenMint: candidate.tokenMint,
        tokenSymbol: candidate.tokenSymbol,
        poolAddress: candidate.poolAddress,
        decision: {
          selected: candidate.selected,
          selectionRank: candidate.selectionRank,
          blockedReason: candidate.blockedReason,
          rejectionStage: candidate.rejectionStage,
          runtimeMode: candidate.runtimeMode,
          sessionPhase: candidate.sessionPhase
        },
        candidateFeatures: {
          liquidityUsd: candidate.liquidityUsd,
          holders: candidate.holders,
          safetyScore: candidate.safetyScore,
          volume24h: candidate.volume24h,
          feeTvlRatio24h: candidate.feeTvlRatio24h,
          binStep: candidate.binStep,
          hasInventory: candidate.hasInventory,
          hasLpPosition: candidate.hasLpPosition
        },
        futurePath: {
          observationCount: snapshots.length,
          latestWindowLabel: latestSnapshot?.windowLabel ?? null,
          latestValueSol,
          maxObservedValueSol: observedValues.length > 0 ? Math.max(...observedValues) : null,
          minObservedValueSol: observedValues.length > 0 ? Math.min(...observedValues) : null,
          latestLiquidityUsd: typeof latestSnapshot?.liquidityUsd === 'number' ? latestSnapshot.liquidityUsd : null,
          hasInventoryFollowThrough: latestSnapshot?.hasInventory ?? null,
          hasLpPositionFollowThrough: latestSnapshot?.hasLpPosition ?? null,
          outcomeCount: outcomes.length,
          latestOutcomeReason: latestOutcome?.actualExitReason ?? null,
          latestExitMetricValue: latestExitMetricValue(latestOutcome)
        },
        counterfactual: {
          selectedBaselineValueSol: selectedBaselineValueSol ?? null,
          relativeToSelectedBaselineSol,
          outperformedSelectedBaseline:
            typeof relativeToSelectedBaselineSol === 'number'
              ? relativeToSelectedBaselineSol > 0
              : null
        }
      } satisfies PoolDecisionSampleRecord;
    });
  });
}

function computeSelectedBaseline(
  scan: CandidateScanRecord,
  watchlistSnapshots: WatchlistSnapshotRecord[]
) {
  const selectedValues = scan.candidates
    .filter((candidate) => candidate.selected)
    .map((candidate) => {
      const latestSnapshot = watchlistSnapshots
        .filter((snapshot) =>
          snapshot.tokenMint === candidate.tokenMint
          && snapshot.poolAddress === candidate.poolAddress
          && Date.parse(snapshot.observationAt) >= Date.parse(candidate.capturedAt)
        )
        .sort((left, right) => left.observationAt.localeCompare(right.observationAt))
        .at(-1);

      return latestSnapshot?.currentValueSol;
    })
    .filter((value): value is number => typeof value === 'number');

  if (selectedValues.length === 0) {
    return null;
  }

  return roundMetric(selectedValues.reduce((sum, value) => sum + value, 0) / selectedValues.length);
}

function latestExitMetricValue(outcome: LiveCycleOutcomeRecord | undefined) {
  if (!outcome) {
    return null;
  }

  if (typeof outcome.actualExitMetricValue === 'number') {
    return outcome.actualExitMetricValue;
  }

  if (typeof outcome.exitMetrics.quoteOutputSol === 'number') {
    return outcome.exitMetrics.quoteOutputSol;
  }

  if (typeof outcome.exitMetrics.lpCurrentValueSol === 'number') {
    return outcome.exitMetrics.lpCurrentValueSol;
  }

  return null;
}

function roundMetric(value: number) {
  return Math.round(value * 10000) / 10000;
}
