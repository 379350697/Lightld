import type {
  AnalysisNoActionReason,
  EvolutionStrategyId,
  OutcomeReviewRecord,
  ParameterFinding,
  ParameterProposalRecord
} from './types.ts';
import type { FilterAnalysisResult } from './filter-analysis.ts';
import type { OutcomeAnalysisResult } from './outcome-analysis.ts';
import type { EvolutionAnalysisContext } from './scoring.ts';
import { isDecisionReady } from './scoring.ts';

const PATCHABLE_PATHS = new Set([
  'filters.minLiquidityUsd',
  'riskThresholds.takeProfitPct',
  'riskThresholds.stopLossPct',
  'lpConfig.stopLossNetPnlPct',
  'lpConfig.takeProfitNetPnlPct',
  'lpConfig.solDepletionExitBins',
  'lpConfig.minBinStep',
  'lpConfig.minVolume24hUsd',
  'lpConfig.minFeeTvlRatio24h'
]);

type ProposalValue = number | string | boolean | null | undefined;

export type GenerateEvolutionProposalsInput = {
  strategyId: EvolutionStrategyId;
  createdAt: string;
  currentValues: Record<string, ProposalValue>;
  filterAnalysis: FilterAnalysisResult;
  outcomeAnalysis: OutcomeAnalysisResult;
  analysisContext?: EvolutionAnalysisContext;
  existingProposals?: ParameterProposalRecord[];
  outcomeReviews?: OutcomeReviewRecord[];
};

export type ProposalGenerationResult = {
  parameterProposals: ParameterProposalRecord[];
  systemProposals: ParameterProposalRecord[];
  noActionReasons: AnalysisNoActionReason[];
};

export function generateEvolutionProposals(input: GenerateEvolutionProposalsInput): ProposalGenerationResult {
  const findings = dedupeFindings([
    ...input.filterAnalysis.findings,
    ...input.outcomeAnalysis.findings
  ]);
  const suppressionContext = buildSuppressionContext({
    existingProposals: input.existingProposals ?? [],
    outcomeReviews: input.outcomeReviews ?? []
  });
  const parameterProposals: ParameterProposalRecord[] = [];
  const systemProposals: ParameterProposalRecord[] = [];
  const noActionReasons = new Set<AnalysisNoActionReason>([
    ...input.filterAnalysis.noActionReasons,
    ...input.outcomeAnalysis.noActionReasons
  ]);
  const decisionReady = input.analysisContext
    ? isDecisionReady(input.analysisContext)
    : true;

  if (input.analysisContext && input.analysisContext.coverageScore < 0.55) {
    noActionReasons.add('data_coverage_gaps');
  }

  if (input.analysisContext && input.analysisContext.regimeScore < 0.55) {
    noActionReasons.add('regime_instability');
  }

  for (const finding of findings) {
    if (finding.direction === 'hold') {
      continue;
    }

    const currentValue = input.currentValues[finding.path];

    if (!PATCHABLE_PATHS.has(finding.path)) {
      systemProposals.push(buildProposal({
        proposalKind: 'system',
        strategyId: input.strategyId,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        targetPath: finding.path,
        oldValue: currentValue ?? null,
        proposedValue: null,
        sampleSize: finding.sampleSize,
        rationale: finding.rationale,
        expectedImprovement: 'Requires a code or ranking logic change rather than a YAML patch.',
        riskNote: 'System proposals are advisory only in phase 1.',
        uncertaintyNote: `Confidence=${finding.confidence}.`,
        patchable: false
      }));
      continue;
    }

    const oldValue = typeof currentValue === 'undefined'
      ? defaultCurrentValueForPath(finding.path)
      : currentValue;
    const proposedValue = deriveProposedValue(oldValue, finding);
    const candidateProposal = buildProposal({
      proposalKind: 'parameter',
      strategyId: input.strategyId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      targetPath: finding.path,
      oldValue: oldValue ?? null,
      proposedValue,
      evidenceWindowHours: 24,
      sampleSize: finding.sampleSize,
      analysisConfidence: finding.confidence,
      supportingMetric: finding.supportingMetric,
      coverageScore: input.analysisContext?.coverageScore,
      regimeScore: input.analysisContext?.regimeScore,
      proposalReadinessScore: input.analysisContext?.proposalReadinessScore,
      rationale: finding.rationale,
      expectedImprovement: expectedImprovementForPath(finding.path, finding.direction),
      riskNote: riskNoteForPath(finding.path, finding.direction),
      uncertaintyNote: `Confidence=${finding.confidence}. Supporting metric=${finding.supportingMetric ?? 0}.`,
      patchable: true
    });

    if (!decisionReady) {
      continue;
    }

    if (shouldSuppressProposal(candidateProposal, suppressionContext)) {
      noActionReasons.add('conflicting_evidence');
      continue;
    }

    parameterProposals.push(candidateProposal);
  }

  if (parameterProposals.length === 0) {
    noActionReasons.add('no_safe_parameter_proposal');
  }

  return {
    parameterProposals,
    systemProposals,
    noActionReasons: [...noActionReasons]
  };
}

function dedupeFindings(findings: ParameterFinding[]) {
  const deduped = new Map<string, ParameterFinding>();

  for (const finding of findings) {
    const existing = deduped.get(finding.path);
    if (!existing || existing.sampleSize < finding.sampleSize) {
      deduped.set(finding.path, finding);
    }
  }

  return [...deduped.values()];
}

function buildProposal(
  proposal: Omit<ParameterProposalRecord, 'proposalId' | 'status'>
): ParameterProposalRecord {
  return {
    proposalId: `${proposal.proposalKind}:${proposal.targetPath}:${proposal.createdAt}`,
    status: 'draft',
    ...proposal
  };
}

function deriveProposedValue(currentValue: ProposalValue, finding: ParameterFinding): ProposalValue {
  if (typeof currentValue !== 'number') {
    return currentValue ?? null;
  }

  if (finding.direction === 'increase') {
    if (currentValue === 0 && finding.path === 'lpConfig.minFeeTvlRatio24h') {
      return 0.01;
    }

    return roundForPath(finding.path, currentValue * 1.1);
  }

  if (finding.direction === 'decrease') {
    return roundForPath(finding.path, currentValue * 0.9);
  }

  return currentValue;
}

function defaultCurrentValueForPath(path: string): ProposalValue {
  const defaults: Record<string, number> = {
    'riskThresholds.takeProfitPct': 20,
    'riskThresholds.stopLossPct': 12
  };

  return defaults[path];
}

function roundForPath(path: string, value: number) {
  if (path.endsWith('Pct') || path.endsWith('Ratio24h')) {
    return Number(value.toFixed(2));
  }

  return Math.max(0, Math.round(value));
}

function expectedImprovementForPath(path: string, direction: ParameterFinding['direction']) {
  if (path === 'filters.minLiquidityUsd' && direction === 'decrease') {
    return 'Admit promising tokens that were previously filtered too aggressively.';
  }

  if (path === 'lpConfig.solDepletionExitBins' && direction === 'increase') {
    return 'Allow LP positions more time to harvest trend continuation and fees.';
  }

  return 'Move the parameter in the direction indicated by the research evidence.';
}

function riskNoteForPath(path: string, direction: ParameterFinding['direction']) {
  if (path === 'filters.minLiquidityUsd' && direction === 'decrease') {
    return 'Lower liquidity thresholds may admit noisier or less defendable pools.';
  }

  if (path === 'lpConfig.solDepletionExitBins' && direction === 'increase') {
    return 'Higher depletion tolerance can keep capital exposed longer during reversals.';
  }

  return 'Operator review is required before applying this change.';
}

function buildSuppressionContext(input: {
  existingProposals: ParameterProposalRecord[];
  outcomeReviews: OutcomeReviewRecord[];
}) {
  const proposalById = new Map(input.existingProposals.map((proposal) => [proposal.proposalId, proposal]));
  const latestReviewByPath = new Map<string, { proposal: ParameterProposalRecord; review: OutcomeReviewRecord }>();
  const reviewHistoryByPath = new Map<string, Array<{ proposal: ParameterProposalRecord; review: OutcomeReviewRecord }>>();

  for (const review of input.outcomeReviews) {
    const proposal = proposalById.get(review.proposalId);
    if (!proposal) {
      continue;
    }

    const history = reviewHistoryByPath.get(proposal.targetPath) ?? [];
    history.push({ proposal, review });
    reviewHistoryByPath.set(proposal.targetPath, history);

    const existing = latestReviewByPath.get(proposal.targetPath);
    if (!existing || existing.review.reviewedAt < review.reviewedAt) {
      latestReviewByPath.set(proposal.targetPath, { proposal, review });
    }
  }

  return {
    existingProposals: input.existingProposals,
    latestReviewByPath,
    reviewHistoryByPath
  };
}

function shouldSuppressProposal(
  proposal: ParameterProposalRecord,
  context: ReturnType<typeof buildSuppressionContext>
) {
  const existingProposal = context.existingProposals.find((entry) =>
    entry.targetPath === proposal.targetPath
    && entry.status === 'approved'
    && valuesMatch(entry.proposedValue, proposal.proposedValue)
  );
  if (existingProposal) {
    return true;
  }

  const latestReview = context.latestReviewByPath.get(proposal.targetPath);
  if (!latestReview) {
    return false;
  }

  const reviewHistory = context.reviewHistoryByPath.get(proposal.targetPath) ?? [];
  const reviewedDirection = directionForProposal(latestReview.proposal);
  const currentDirection = directionForProposal(proposal);
  if (reviewedDirection !== currentDirection) {
    return false;
  }

  const repeatedWeakHistory = reviewHistory.filter(({ proposal: historicalProposal, review }) =>
    directionForProposal(historicalProposal) === currentDirection
    && (review.status === 'needs_more_data' || review.status === 'mixed')
  );

  if (repeatedWeakHistory.length >= 2 && !isMeaningfullyStronger(proposal, repeatedWeakHistory.map((entry) => entry.proposal))) {
    return true;
  }

  return latestReview.review.status === 'rejected' || latestReview.review.status === 'mixed';
}

function directionForProposal(proposal: Pick<ParameterProposalRecord, 'oldValue' | 'proposedValue'>) {
  if (typeof proposal.oldValue === 'number' && typeof proposal.proposedValue === 'number') {
    if (proposal.proposedValue > proposal.oldValue) {
      return 'increase' as const;
    }

    if (proposal.proposedValue < proposal.oldValue) {
      return 'decrease' as const;
    }
  }

  return 'hold' as const;
}

function valuesMatch(left: unknown, right: unknown) {
  return left === right || (typeof left === 'undefined' && right === null);
}

function isMeaningfullyStronger(
  proposal: Pick<ParameterProposalRecord, 'sampleSize' | 'analysisConfidence' | 'supportingMetric'>,
  historicalProposals: Array<Pick<ParameterProposalRecord, 'sampleSize' | 'analysisConfidence' | 'supportingMetric'>>
) {
  const maxHistoricalSampleSize = Math.max(...historicalProposals.map((entry) => entry.sampleSize ?? 0), 0);
  const maxHistoricalMetric = Math.max(...historicalProposals.map((entry) => entry.supportingMetric ?? 0), 0);
  const maxHistoricalConfidence = Math.max(...historicalProposals.map((entry) => confidenceRank(entry.analysisConfidence)), 0);

  return (
    (proposal.sampleSize ?? 0) >= maxHistoricalSampleSize + 2
    || confidenceRank(proposal.analysisConfidence) > maxHistoricalConfidence
    || (proposal.supportingMetric ?? 0) >= maxHistoricalMetric + 0.1
  );
}

function confidenceRank(confidence: ParameterProposalRecord['analysisConfidence']) {
  if (confidence === 'high') {
    return 3;
  }

  if (confidence === 'medium') {
    return 2;
  }

  if (confidence === 'low') {
    return 1;
  }

  return 0;
}
