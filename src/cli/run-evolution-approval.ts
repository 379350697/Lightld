import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ApprovalStore, generatePatchDraft, resolveEvolutionPaths } from '../evolution/index.ts';
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
  if (args.action === 'approve' && proposal.patchable) {
    const patchDraft = await generatePatchDraft({
      proposalId: proposal.proposalId,
      baselineConfigPath: strategyConfigPathFor(args.strategyId),
      proposals: [proposal]
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
    }
  }

  await store.applyDecision({
    proposalId: args.proposalId,
    action: args.action,
    note: args.note,
    decidedAt,
    relatedReportPath: paths.reportJsonPath,
    generatedPatchDraftPath: patchPath
  });

  return {
    status: args.action === 'approve' ? 'approved' : args.action === 'reject' ? 'rejected' : 'deferred',
    patchPath
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
