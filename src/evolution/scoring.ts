import type { FilterAnalysisResult } from './filter-analysis.ts';
import type { OutcomeAnalysisResult } from './outcome-analysis.ts';

export const PROPOSAL_MIN_COVERAGE_SCORE = 0.55;
export const PROPOSAL_MIN_REGIME_SCORE = 0.55;
export const PROPOSAL_MIN_READINESS_SCORE = 0.6;

export type EvolutionCoverageBreakdown = {
  candidateScanCoverage: number;
  watchlistCoverage: number;
  outcomeCoverage: number;
  followThroughCoverage: number;
};

export type EvolutionAnalysisContext = {
  coverageScore: number;
  regimeScore: number;
  proposalReadinessScore: number;
  regimeLabels: string[];
  coverageBreakdown: EvolutionCoverageBreakdown;
};

export function buildEvolutionAnalysisContext(input: {
  candidateScans: number;
  watchlistSnapshots: number;
  outcomes: number;
  filterAnalysis: FilterAnalysisResult;
  outcomeAnalysis: OutcomeAnalysisResult;
}): EvolutionAnalysisContext {
  const candidateScanCoverage = normalizeCount(input.candidateScans, 2);
  const watchlistCoverage = normalizeCount(input.watchlistSnapshots, 2);
  const outcomeCoverage = input.outcomes > 0
    ? normalizeCount(input.outcomes, 4)
    : watchlistCoverage >= 0.75
      ? 0.6
      : roundScore(watchlistCoverage * 0.4);
  const followThroughCoverage = input.outcomes > 0
    ? roundScore(input.outcomeAnalysis.summary.matchedFollowThroughCount / Math.max(1, input.outcomes))
    : input.watchlistSnapshots > 0 && input.candidateScans > 0
      ? roundScore(0.3 + watchlistCoverage * 0.4)
      : 0;
  const coverageScore = roundScore(
    candidateScanCoverage * 0.35
    + watchlistCoverage * 0.45
    + outcomeCoverage * 0.2
  );
  const balanceScore = input.candidateScans > 0 && input.watchlistSnapshots > 0
    ? input.outcomes > 0 || watchlistCoverage >= 0.75
      ? 1
      : 0.7
    : 0;
  let penalty = 0;

  if (input.candidateScans === 0) {
    penalty += 0.2;
  }

  if (input.watchlistSnapshots === 0) {
    penalty += 0.25;
  }

  if (input.outcomes > 0 && input.outcomeAnalysis.summary.matchedFollowThroughCount === 0) {
    penalty += 0.1;
  }

  const regimeScore = roundScore(clampScore(
    coverageScore * 0.45
    + followThroughCoverage * 0.35
    + balanceScore * 0.2
    - penalty
  ));
  const proposalReadinessScore = roundScore(clampScore(
    coverageScore * 0.55
    + regimeScore * 0.45
  ));

  return {
    coverageScore,
    regimeScore,
    proposalReadinessScore,
    regimeLabels: deriveRegimeLabels({
      candidateScans: input.candidateScans,
      watchlistSnapshots: input.watchlistSnapshots,
      outcomes: input.outcomes,
      coverageScore,
      regimeScore,
      followThroughCoverage
    }),
    coverageBreakdown: {
      candidateScanCoverage,
      watchlistCoverage,
      outcomeCoverage,
      followThroughCoverage
    }
  };
}

export function isDecisionReady(context: Pick<
  EvolutionAnalysisContext,
  'coverageScore' | 'regimeScore' | 'proposalReadinessScore'
>) {
  return context.coverageScore >= PROPOSAL_MIN_COVERAGE_SCORE
    && context.regimeScore >= PROPOSAL_MIN_REGIME_SCORE
    && context.proposalReadinessScore >= PROPOSAL_MIN_READINESS_SCORE;
}

function deriveRegimeLabels(input: {
  candidateScans: number;
  watchlistSnapshots: number;
  outcomes: number;
  coverageScore: number;
  regimeScore: number;
  followThroughCoverage: number;
}) {
  if (input.candidateScans === 0 && input.watchlistSnapshots === 0 && input.outcomes === 0) {
    return ['cold-start'];
  }

  const labels = ['active-observation'];

  if (input.outcomes === 0) {
    labels.push('pre-outcome-window');
  }

  if (input.coverageScore < PROPOSAL_MIN_COVERAGE_SCORE) {
    labels.push('thin-coverage');
  }

  if (input.regimeScore < PROPOSAL_MIN_REGIME_SCORE) {
    labels.push('unstable-window');
  }

  if (input.followThroughCoverage >= 0.6) {
    labels.push('follow-through-ready');
  }

  return labels;
}

function normalizeCount(value: number, target: number) {
  return roundScore(clampScore(value / target));
}

function clampScore(value: number) {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number) {
  return Math.round(value * 100) / 100;
}
