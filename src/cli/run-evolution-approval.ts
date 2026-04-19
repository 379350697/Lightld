import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ApprovalStore,
  generatePatchDraft,
  resolveEvolutionPaths,
  type ProposalValidationRecord
} from '../evolution/index.ts';
import { writeJsonAtomically } from '../runtime/atomic-file.ts';

export type RunEvolutionApprovalArgs = {
  strategyId: 'new-token-v1' | 'large-pool-v1';
  stateRootDir: string;
  proposalId: string;
  action: 'approve' | 'reject' | 'defer';
  note?: string;
};

export function parseRunEvolutionApprovalArgs(argv: string[]): RunEvolutionApprovalArgs {
  const parsed: RunEvolutionApprovalArgs = {
    strategyId: 'new-token-v1',
    stateRootDir: 'state',
    proposalId: '',
    action: 'defer'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--strategy' && next && (next === 'new-token-v1' || next === 'large-pool-v1')) {
      parsed.strategyId = next;
      index += 1;
      continue;
    }

    if (current === '--state-root-dir' && next) {
      parsed.stateRootDir = next;
      index += 1;
      continue;
    }

    if (current === '--proposal-id' && next) {
      parsed.proposalId = next;
      index += 1;
      continue;
    }

    if (current === '--action' && next && (next === 'approve' || next === 'reject' || next === 'defer')) {
      parsed.action = next;
      index += 1;
      continue;
    }

    if (current === '--note' && next) {
      parsed.note = next;
      index += 1;
    }
  }

  return parsed;
}

export async function runEvolutionApproval(args: RunEvolutionApprovalArgs) {
  const paths = resolveEvolutionPaths(args.strategyId, join(args.stateRootDir, 'evolution'));
  const store = new ApprovalStore(paths.approvalQueuePath, {
    decisionLogPath: paths.approvalHistoryPath,
    outcomeLedgerPath: paths.outcomeLedgerPath
  });
  const queue = await store.readQueue();
  const proposal = queue.find((entry) => entry.proposalId === args.proposalId);

  if (!proposal) {
    throw new Error(`Proposal not found: ${args.proposalId}`);
  }

  const decidedAt = new Date().toISOString();
  let patchPath: string | undefined;
  let patchBlockedNote: string | undefined;
  if (args.action === 'approve' && proposal.patchable) {
    const patchDraft = await generatePatchDraft({
      proposalId: proposal.proposalId,
      baselineConfigPath: strategyConfigPathFor(args.strategyId),
      proposals: [proposal],
      proposalValidations: await loadProposalValidations(paths.reportJsonPath)
    });

    if (patchDraft.status === 'ready' && patchDraft.patchYaml) {
      const safeFileName = sanitizeProposalFileName(proposal.proposalId);
      patchPath = join(paths.approvedPatchesDir, `${safeFileName}.yaml`);
      await mkdir(dirname(patchPath), { recursive: true });
      await writeFile(patchPath, `${patchDraft.patchYaml}\n`, 'utf8');
      await writeJsonAtomically(
        join(paths.approvedPatchesDir, `${safeFileName}.meta.json`),
        {
          ...patchDraft.metadata,
          proposalId: proposal.proposalId,
          approvedAt: decidedAt
        }
      );
    } else if (patchDraft.status === 'blocked') {
      patchBlockedNote = patchDraft.blockedNote;
    }
  }

  await store.applyDecision({
    proposalId: args.proposalId,
    action: args.action,
    note: args.note ?? patchBlockedNote,
    decidedAt,
    relatedReportPath: paths.reportJsonPath,
    generatedPatchDraftPath: patchPath
  });

  return {
    status: args.action === 'approve' ? 'approved' : args.action === 'reject' ? 'rejected' : 'deferred',
    patchPath,
    patchBlockedNote
  };
}

function strategyConfigPathFor(strategyId: 'new-token-v1' | 'large-pool-v1') {
  return strategyId === 'new-token-v1'
    ? 'src/config/strategies/new-token-v1.yaml'
    : 'src/config/strategies/large-pool-v1.yaml';
}

function sanitizeProposalFileName(proposalId: string) {
  return proposalId.replace(/[<>:"/\\|?*]/g, '_');
}

async function loadProposalValidations(reportJsonPath: string): Promise<ProposalValidationRecord[]> {
  try {
    const raw = await readFile(reportJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      proposalValidations?: Array<{
        proposalId?: string;
        targetPath?: string;
        status?: string;
        note?: string;
        sampleCount?: number;
        outperformRate?: number | null;
        averageRelativeToSelectedBaselineSol?: number | null;
        recentSliceLabel?: string | null;
        recentSliceSampleCount?: number;
        recentSliceOutperformRate?: number | null;
        recentSliceAverageRelativeToSelectedBaselineSol?: number | null;
      }>;
    };

    return (parsed.proposalValidations ?? [])
      .filter((validation) => typeof validation.proposalId === 'string' && typeof validation.targetPath === 'string')
      .map((validation) => ({
        proposalId: validation.proposalId as string,
        targetPath: validation.targetPath as string,
        status: validation.status === 'supported' ? 'supported' : validation.status === 'mixed' ? 'mixed' : 'insufficient_evidence',
        note: typeof validation.note === 'string' ? validation.note : '',
        sampleCount: typeof validation.sampleCount === 'number' ? validation.sampleCount : 0,
        outperformRate: typeof validation.outperformRate === 'number' ? validation.outperformRate : null,
        averageRelativeToSelectedBaselineSol:
          typeof validation.averageRelativeToSelectedBaselineSol === 'number'
            ? validation.averageRelativeToSelectedBaselineSol
            : null,
        recentSliceLabel: typeof validation.recentSliceLabel === 'string' ? validation.recentSliceLabel : null,
        recentSliceSampleCount:
          typeof validation.recentSliceSampleCount === 'number' ? validation.recentSliceSampleCount : 0,
        recentSliceOutperformRate:
          typeof validation.recentSliceOutperformRate === 'number' ? validation.recentSliceOutperformRate : null,
        recentSliceAverageRelativeToSelectedBaselineSol:
          typeof validation.recentSliceAverageRelativeToSelectedBaselineSol === 'number'
            ? validation.recentSliceAverageRelativeToSelectedBaselineSol
            : null
      }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
