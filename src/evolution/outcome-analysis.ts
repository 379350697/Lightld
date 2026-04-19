import type {
  AnalysisNoActionReason,
  LiveCycleOutcomeRecord,
  ParameterFinding,
  WatchlistSnapshotRecord
} from './types.ts';

export type OutcomeAnalysisSummary = {
  totalOutcomes: number;
  matchedFollowThroughCount: number;
};

export type OutcomeAnalysisResult = {
  summary: OutcomeAnalysisSummary;
  findings: ParameterFinding[];
  noActionReasons: AnalysisNoActionReason[];
};

type AnalyzeOutcomeEvidenceInput = {
  outcomes: LiveCycleOutcomeRecord[];
  watchlistSnapshots: WatchlistSnapshotRecord[];
  minimumSampleSize?: number;
};

export function analyzeOutcomeEvidence(input: AnalyzeOutcomeEvidenceInput): OutcomeAnalysisResult {
  const minimumSampleSize = input.minimumSampleSize ?? 5;
  const noActionReasons = new Set<AnalysisNoActionReason>();
  const matchedSamples = {
    takeProfit: 0,
    stopLoss: 0,
    solDepletion: 0,
    lpStopLoss: 0,
    lpTakeProfit: 0
  };
  const findings: ParameterFinding[] = [];
  let matchedFollowThroughCount = 0;

  if (input.outcomes.length < minimumSampleSize) {
    noActionReasons.add('insufficient_sample_size');
  }

  for (const outcome of input.outcomes) {
    const snapshot = buildLatestSnapshotAfterExit({
      tokenMint: outcome.tokenMint,
      closedAt: outcome.closedAt,
      watchlistSnapshots: input.watchlistSnapshots
    });
    if (!snapshot || typeof snapshot.currentValueSol !== 'number') {
      continue;
    }

    matchedFollowThroughCount += 1;

    if (outcome.actualExitReason.includes('lp-stop-loss')) {
      const exitValue = outcome.exitMetrics.lpCurrentValueSol;
      if (typeof exitValue === 'number' && snapshot.currentValueSol < exitValue * 0.75) {
        matchedSamples.lpStopLoss += 1;
      }
      continue;
    }

    if (outcome.actualExitReason.includes('lp-take-profit')) {
      const exitValue = outcome.exitMetrics.lpCurrentValueSol;
      if (typeof exitValue === 'number' && snapshot.currentValueSol > exitValue * 1.2) {
        matchedSamples.lpTakeProfit += 1;
      }
      continue;
    }

    if (outcome.actualExitReason.includes('take-profit')) {
      const exitValue = outcome.exitMetrics.quoteOutputSol;
      if (typeof exitValue === 'number' && snapshot.currentValueSol > exitValue * 1.2) {
        matchedSamples.takeProfit += 1;
      }
      continue;
    }

    if (outcome.actualExitReason.includes('stop-loss')) {
      const exitValue = outcome.exitMetrics.quoteOutputSol;
      if (typeof exitValue === 'number' && snapshot.currentValueSol < exitValue * 0.75) {
        matchedSamples.stopLoss += 1;
      }
      continue;
    }

    if (
      outcome.actualExitReason.includes('sol-depletion')
      || outcome.exitMetrics.lpSolDepletedBins === outcome.parameterSnapshot.lpSolDepletionExitBins
    ) {
      const exitValue = outcome.exitMetrics.lpCurrentValueSol;
      if (typeof exitValue === 'number' && snapshot.currentValueSol > exitValue * 1.2) {
        matchedSamples.solDepletion += 1;
      }
    }
  }

  if (matchedFollowThroughCount === 0) {
    noActionReasons.add('data_coverage_gaps');
  }

  if (matchedSamples.takeProfit > 0) {
    findings.push({
      path: 'riskThresholds.takeProfitPct',
      direction: 'increase',
      sampleSize: matchedSamples.takeProfit,
      confidence: confidenceForSamples(matchedSamples.takeProfit),
      rationale: 'Take-profit exits were followed by continued upside in later watchlist observations.',
      supportingMetric: matchedSamples.takeProfit / Math.max(1, matchedFollowThroughCount)
    });
  }

  if (matchedSamples.stopLoss > 0) {
    findings.push({
      path: 'riskThresholds.stopLossPct',
      direction: 'decrease',
      sampleSize: matchedSamples.stopLoss,
      confidence: confidenceForSamples(matchedSamples.stopLoss),
      rationale: 'Stop-loss exits were followed by further downside, suggesting tighter loss containment.',
      supportingMetric: matchedSamples.stopLoss / Math.max(1, matchedFollowThroughCount)
    });
  }

  if (matchedSamples.solDepletion > 0) {
    findings.push({
      path: 'lpConfig.solDepletionExitBins',
      direction: 'increase',
      sampleSize: matchedSamples.solDepletion,
      confidence: confidenceForSamples(matchedSamples.solDepletion),
      rationale: 'LP exits at the current depletion threshold were followed by continued upside and fee potential.',
      supportingMetric: matchedSamples.solDepletion / Math.max(1, matchedFollowThroughCount)
    });
  }

  if (matchedSamples.lpStopLoss > 0) {
    findings.push({
      path: 'lpConfig.stopLossNetPnlPct',
      direction: 'decrease',
      sampleSize: matchedSamples.lpStopLoss,
      confidence: confidenceForSamples(matchedSamples.lpStopLoss),
      rationale: 'LP stop-loss exits were followed by further downside, suggesting tighter LP loss containment.',
      supportingMetric: matchedSamples.lpStopLoss / Math.max(1, matchedFollowThroughCount)
    });
  }

  if (matchedSamples.lpTakeProfit > 0) {
    findings.push({
      path: 'lpConfig.takeProfitNetPnlPct',
      direction: 'increase',
      sampleSize: matchedSamples.lpTakeProfit,
      confidence: confidenceForSamples(matchedSamples.lpTakeProfit),
      rationale: 'LP take-profit exits were followed by continued upside, suggesting the LP profit target may be too tight.',
      supportingMetric: matchedSamples.lpTakeProfit / Math.max(1, matchedFollowThroughCount)
    });
  }

  if (findings.length === 0 && noActionReasons.size === 0) {
    noActionReasons.add('no_safe_parameter_proposal');
  }

  return {
    summary: {
      totalOutcomes: input.outcomes.length,
      matchedFollowThroughCount
    },
    findings,
    noActionReasons: [...noActionReasons]
  };
}

function confidenceForSamples(sampleSize: number): ParameterFinding['confidence'] {
  if (sampleSize >= 5) {
    return 'high';
  }

  if (sampleSize >= 3) {
    return 'medium';
  }

  return 'low';
}

function buildLatestSnapshotAfterExit(input: {
  tokenMint: string;
  closedAt?: string;
  watchlistSnapshots: WatchlistSnapshotRecord[];
}) {
  const closedAtMs = typeof input.closedAt === 'string' ? Date.parse(input.closedAt) : Number.NaN;

  return input.watchlistSnapshots
    .filter((snapshot) => {
      if (snapshot.tokenMint !== input.tokenMint) {
        return false;
      }

      if (!Number.isFinite(closedAtMs)) {
        return true;
      }

      return Date.parse(snapshot.observationAt) >= closedAtMs;
    })
    .sort((left, right) => right.observationAt.localeCompare(left.observationAt))[0];
}
