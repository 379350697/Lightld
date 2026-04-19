import { readFile } from 'node:fs/promises';

import { parse, stringify } from 'yaml';

import type { ParameterProposalRecord } from './types.ts';
import type { ProposalValidationRecord } from './proposal-validator.ts';
import {
  PROPOSAL_MIN_COVERAGE_SCORE,
  PROPOSAL_MIN_READINESS_SCORE,
  PROPOSAL_MIN_REGIME_SCORE
} from './scoring.ts';

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

export type PatchDraftResult = {
  status: 'ready' | 'blocked';
  blockedReason?: 'baseline_drift' | 'too_many_changes' | 'unrelated_parameter_group' | 'unsafe_path' | 'insufficient_evidence';
  blockedNote?: string;
  patchYaml: string | null;
  metadata: {
    proposalId: string;
    proposalCount: number;
    targetPaths: string[];
    sampleSize: number;
  };
};

type GeneratePatchDraftInput = {
  proposalId: string;
  baselineConfigPath: string;
  proposals: ParameterProposalRecord[];
  proposalValidations?: ProposalValidationRecord[];
};

export async function generatePatchDraft(input: GeneratePatchDraftInput): Promise<PatchDraftResult> {
  if (input.proposals.length === 0) {
    return blockedResult(input.proposalId, input.proposals, 'unsafe_path');
  }

  if (input.proposals.length > 3) {
    return blockedResult(input.proposalId, input.proposals, 'too_many_changes');
  }

  if (input.proposals.some((proposal) => !proposal.patchable || !PATCHABLE_PATHS.has(proposal.targetPath))) {
    return blockedResult(input.proposalId, input.proposals, 'unsafe_path');
  }

  const evidenceBlock = resolveEvidenceBlock(input.proposals, input.proposalValidations);
  if (evidenceBlock) {
    return blockedResult(input.proposalId, input.proposals, 'insufficient_evidence', evidenceBlock);
  }

  const groups = new Set(input.proposals.map((proposal) => proposal.targetPath.split('.')[0]));
  if (groups.size > 1) {
    return blockedResult(input.proposalId, input.proposals, 'unrelated_parameter_group');
  }

  const baseline = parse(await readFile(input.baselineConfigPath, 'utf8')) as Record<string, unknown>;

  for (const proposal of input.proposals) {
    const baselineValue = getPathValue(baseline, proposal.targetPath);
    if (!valuesMatch(baselineValue, proposal.oldValue)) {
      return blockedResult(input.proposalId, input.proposals, 'baseline_drift');
    }
  }

  const patchDocument: Record<string, unknown> = {};
  for (const proposal of input.proposals) {
    setPathValue(patchDocument, proposal.targetPath, proposal.proposedValue ?? null);
  }

  return {
    status: 'ready',
    patchYaml: stringify(patchDocument).trim(),
    metadata: buildMetadata(input.proposalId, input.proposals)
  };
}

function buildMetadata(proposalId: string, proposals: ParameterProposalRecord[]) {
  return {
    proposalId,
    proposalCount: proposals.length,
    targetPaths: proposals.map((proposal) => proposal.targetPath),
    sampleSize: proposals.reduce((sum, proposal) => sum + (proposal.sampleSize ?? 0), 0)
  };
}

function blockedResult(
  proposalId: string,
  proposals: ParameterProposalRecord[],
  blockedReason: PatchDraftResult['blockedReason'],
  blockedNote?: string
): PatchDraftResult {
  return {
    status: 'blocked',
    blockedReason,
    blockedNote,
    patchYaml: null,
    metadata: buildMetadata(proposalId, proposals)
  };
}

function getPathValue(root: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), root);
}

function setPathValue(root: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = root;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = cursor[segment];

    if (!isRecord(next)) {
      cursor[segment] = {};
    }

    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]] = value;
}

function valuesMatch(left: unknown, right: unknown) {
  return left === right || (typeof left === 'undefined' && right === null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveEvidenceBlock(
  proposals: ParameterProposalRecord[],
  proposalValidations?: ProposalValidationRecord[]
) {
  for (const proposal of proposals) {
    const blockedNote = resolveProposalEvidenceBlock(proposal, proposalValidations);
    if (blockedNote) {
      return blockedNote;
    }
  }

  return null;
}

function resolveProposalEvidenceBlock(
  proposal: ParameterProposalRecord,
  proposalValidations?: ProposalValidationRecord[]
) {
  if ((proposal.sampleSize ?? 0) < 3) {
    return `Sample size for ${proposal.targetPath} is still below the patch threshold.`;
  }

  if (proposal.analysisConfidence === 'low') {
    return `Analysis confidence for ${proposal.targetPath} is still low.`;
  }

  if (typeof proposal.supportingMetric === 'number' && proposal.supportingMetric < 0.5) {
    return `Supporting metric for ${proposal.targetPath} is still below the acceptance floor.`;
  }

  if (typeof proposal.coverageScore === 'number' && proposal.coverageScore < PROPOSAL_MIN_COVERAGE_SCORE) {
    return `Coverage score for ${proposal.targetPath} is still below the proposal threshold.`;
  }

  if (typeof proposal.regimeScore === 'number' && proposal.regimeScore < PROPOSAL_MIN_REGIME_SCORE) {
    return `Regime score for ${proposal.targetPath} is still below the proposal threshold.`;
  }

  if (
    typeof proposal.proposalReadinessScore === 'number'
    && proposal.proposalReadinessScore < PROPOSAL_MIN_READINESS_SCORE
  ) {
    return `Proposal readiness for ${proposal.targetPath} is still below the patch threshold.`;
  }

  const matchingValidation = proposalValidations?.find((validation) => validation.proposalId === proposal.proposalId);
  if (matchingValidation && matchingValidation.status !== 'supported') {
    if (matchingValidation.recentSliceLabel) {
      return `Counterfactual recent slice (${matchingValidation.recentSliceLabel}) for ${proposal.targetPath} has not held up strongly enough yet.`;
    }

    return matchingValidation.note;
  }

  return null;
}
