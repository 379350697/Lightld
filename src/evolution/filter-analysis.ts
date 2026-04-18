import type {
  AnalysisNoActionReason,
  CandidateScanRecord,
  ParameterFinding,
  WatchlistSnapshotRecord
} from './types.ts';

export type FilterAnalysisSummary = {
  totalScans: number;
  totalCandidates: number;
  selectedCandidateCount: number;
  filteredCandidateCount: number;
  blockedReasonCounts: Array<{ reason: string; count: number }>;
  missedOpportunityCount: number;
};

export type FilterAnalysisResult = {
  summary: FilterAnalysisSummary;
  findings: ParameterFinding[];
  noActionReasons: AnalysisNoActionReason[];
};

type AnalyzeFilterEvidenceInput = {
  candidateScans: CandidateScanRecord[];
  watchlistSnapshots: WatchlistSnapshotRecord[];
  minimumSampleSize?: number;
};

export function analyzeFilterEvidence(input: AnalyzeFilterEvidenceInput): FilterAnalysisResult {
  const minimumSampleSize = input.minimumSampleSize ?? 5;
  const candidates = input.candidateScans.flatMap((scan) => scan.candidates);
  const selectedCandidates = candidates.filter((candidate) => candidate.selected);
  const filteredCandidates = candidates.filter((candidate) => !candidate.selected && candidate.blockedReason.length > 0);
  const blockedReasonCounts = summarizeBlockedReasons(filteredCandidates);
  const latestSnapshotsByToken = buildLatestSnapshotByToken(input.watchlistSnapshots);
  const selectedPerformance = selectedCandidates
    .map((candidate) => latestSnapshotsByToken.get(candidate.tokenMint)?.currentValueSol)
    .filter((value): value is number => typeof value === 'number');
  const selectedBaseline = selectedPerformance.length > 0
    ? average(selectedPerformance)
    : null;
  const noActionReasons = new Set<AnalysisNoActionReason>();
  const findings: ParameterFinding[] = [];
  let missedOpportunityCount = 0;

  if (filteredCandidates.length < minimumSampleSize || input.candidateScans.length < 1) {
    noActionReasons.add('insufficient_sample_size');
  }

  if (selectedBaseline === null) {
    noActionReasons.add('data_coverage_gaps');
  }

  if (selectedBaseline !== null) {
    const reasonStats = new Map<string, { count: number; outperformed: number }>();

    for (const candidate of filteredCandidates) {
      const snapshot = latestSnapshotsByToken.get(candidate.tokenMint);
      if (typeof snapshot?.currentValueSol !== 'number') {
        continue;
      }

      if (snapshot.currentValueSol > selectedBaseline) {
        missedOpportunityCount += 1;
        const stats = reasonStats.get(candidate.blockedReason) ?? { count: 0, outperformed: 0 };
        stats.count += 1;
        stats.outperformed += 1;
        reasonStats.set(candidate.blockedReason, stats);
        continue;
      }

      const stats = reasonStats.get(candidate.blockedReason) ?? { count: 0, outperformed: 0 };
      stats.count += 1;
      reasonStats.set(candidate.blockedReason, stats);
    }

    const minLiquidityStats = reasonStats.get('min-liquidity');
    if (minLiquidityStats && minLiquidityStats.outperformed > 0) {
      findings.push({
        path: 'filters.minLiquidityUsd',
        direction: 'decrease',
        sampleSize: minLiquidityStats.count,
        confidence: confidenceForSamples(minLiquidityStats.count),
        rationale: 'Filtered min-liquidity candidates later outperformed the selected follow-through baseline.',
        supportingMetric: minLiquidityStats.outperformed / minLiquidityStats.count
      });
    }

    const minBinStepStats = reasonStats.get('min-bin-step');
    if (minBinStepStats && minBinStepStats.outperformed > 0) {
      findings.push({
        path: 'lpConfig.minBinStep',
        direction: 'decrease',
        sampleSize: minBinStepStats.count,
        confidence: confidenceForSamples(minBinStepStats.count),
        rationale: 'Candidates blocked by min-bin-step later outperformed selected candidates in watchlist follow-through.',
        supportingMetric: minBinStepStats.outperformed / minBinStepStats.count
      });
    }
  }

  if (findings.length === 0 && noActionReasons.size === 0) {
    noActionReasons.add('no_safe_parameter_proposal');
  }

  return {
    summary: {
      totalScans: input.candidateScans.length,
      totalCandidates: candidates.length,
      selectedCandidateCount: selectedCandidates.length,
      filteredCandidateCount: filteredCandidates.length,
      blockedReasonCounts,
      missedOpportunityCount
    },
    findings,
    noActionReasons: [...noActionReasons]
  };
}

function summarizeBlockedReasons(candidates: CandidateScanRecord['candidates']) {
  const counts = new Map<string, number>();

  for (const candidate of candidates) {
    const reason = candidate.blockedReason;
    if (reason.length === 0) {
      continue;
    }

    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count);
}

function buildLatestSnapshotByToken(watchlistSnapshots: WatchlistSnapshotRecord[]) {
  const snapshots = new Map<string, WatchlistSnapshotRecord>();

  for (const snapshot of watchlistSnapshots) {
    const existing = snapshots.get(snapshot.tokenMint);
    if (!existing || existing.observationAt < snapshot.observationAt) {
      snapshots.set(snapshot.tokenMint, snapshot);
    }
  }

  return snapshots;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
