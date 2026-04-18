import { readJsonIfExists, writeJsonAtomically } from '../runtime/atomic-file.ts';
import {
  ApprovalDecisionSchema,
  ParameterProposalRecordArraySchema,
  type ApprovalDecision,
  type ParameterProposalRecord
} from './types.ts';

export class ApprovalStore {
  constructor(private readonly path: string) {}

  async readQueue(): Promise<ParameterProposalRecord[]> {
    return (await readJsonIfExists(this.path, ParameterProposalRecordArraySchema)) ?? [];
  }

  async upsertProposal(proposal: ParameterProposalRecord): Promise<void> {
    const queue = await this.readQueue();
    const next = queue.filter((entry) => entry.proposalId !== proposal.proposalId);
    next.push(proposal);

    await writeJsonAtomically(this.path, ParameterProposalRecordArraySchema.parse(next));
  }

  async applyDecision(decision: ApprovalDecision): Promise<void> {
    const parsedDecision = ApprovalDecisionSchema.parse(decision);
    const queue = await this.readQueue();
    const next = queue.map((proposal) => {
      if (proposal.proposalId !== parsedDecision.proposalId) {
        return proposal;
      }

      return {
        ...proposal,
        status: decisionToStatus(parsedDecision.action),
        updatedAt: parsedDecision.decidedAt,
        decisionNote: parsedDecision.note,
        decidedAt: parsedDecision.decidedAt
      };
    });

    await writeJsonAtomically(this.path, ParameterProposalRecordArraySchema.parse(next));
  }
}

function decisionToStatus(action: ApprovalDecision['action']): ParameterProposalRecord['status'] {
  if (action === 'approve') {
    return 'approved';
  }

  if (action === 'reject') {
    return 'rejected';
  }

  return 'deferred';
}
