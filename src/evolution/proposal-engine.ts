import type {
  AnalysisNoActionReason,
  EvolutionStrategyId,
  ParameterFinding,
  ParameterProposalRecord
} from './types.ts';
import type { FilterAnalysisResult } from './filter-analysis.ts';
import type { OutcomeAnalysisResult } from './outcome-analysis.ts';

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
  const parameterProposals: ParameterProposalRecord[] = [];
  const systemProposals: ParameterProposalRecord[] = [];
  const noActionReasons = new Set<AnalysisNoActionReason>([
    ...input.filterAnalysis.noActionReasons,
    ...input.outcomeAnalysis.noActionReasons
  ]);

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

    parameterProposals.push(buildProposal({
      proposalKind: 'parameter',
      strategyId: input.strategyId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      targetPath: finding.path,
      oldValue: oldValue ?? null,
      proposedValue,
      evidenceWindowHours: 24,
      sampleSize: finding.sampleSize,
      rationale: finding.rationale,
      expectedImprovement: expectedImprovementForPath(finding.path, finding.direction),
      riskNote: riskNoteForPath(finding.path, finding.direction),
      uncertaintyNote: `Confidence=${finding.confidence}. Supporting metric=${finding.supportingMetric ?? 0}.`,
      patchable: true
    }));
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
