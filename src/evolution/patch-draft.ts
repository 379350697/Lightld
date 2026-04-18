import { readFile } from 'node:fs/promises';

import { parse, stringify } from 'yaml';

import type { ParameterProposalRecord } from './types.ts';

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
  blockedReason?: 'baseline_drift' | 'too_many_changes' | 'unrelated_parameter_group' | 'unsafe_path';
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
  blockedReason: PatchDraftResult['blockedReason']
): PatchDraftResult {
  return {
    status: 'blocked',
    blockedReason,
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
