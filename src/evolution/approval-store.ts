import { appendJsonLine, readJsonLines } from '../journals/jsonl-writer.ts';
import { readJsonIfExists, writeJsonAtomically } from '../runtime/atomic-file.ts';
import {
  ApprovalDecisionSchema,
  ApprovalDecisionRecordSchema,
  type ApprovalDecisionRecord,
  OutcomeReviewRecordSchema,
  ParameterProposalRecordArraySchema,
  type ApprovalDecision,
  type OutcomeReviewRecord,
  type ParameterProposalRecord
} from './types.ts';

export type ApprovalStoreOptions = {
  decisionLogPath?: string;
  outcomeLedgerPath?: string;
};

export class ApprovalStore {
  constructor(
    private readonly path: string,
    private readonly options: ApprovalStoreOptions = {}
  ) {}

  async readQueue(): Promise<ParameterProposalRecord[]> {
    return (await readJsonIfExists(this.path, ParameterProposalRecordArraySchema)) ?? [];
  }

  async readDecisionHistory(): Promise<ApprovalDecisionRecord[]> {
    if (!this.options.decisionLogPath) {
      return [];
    }

    return (await readJsonLines<unknown>(this.options.decisionLogPath))
      .map((entry) => ApprovalDecisionRecordSchema.parse(entry));
  }

  async readOutcomeLedger(): Promise<OutcomeReviewRecord[]> {
    if (!this.options.outcomeLedgerPath) {
      return [];
    }

    return (await readJsonLines<unknown>(this.options.outcomeLedgerPath))
      .map((entry) => OutcomeReviewRecordSchema.parse(entry));
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

    if (this.options.decisionLogPath) {
      await appendJsonLine(this.options.decisionLogPath, ApprovalDecisionRecordSchema.parse(parsedDecision));
    }
  }

  async recordOutcomeReview(review: OutcomeReviewRecord): Promise<void> {
    const parsedReview = OutcomeReviewRecordSchema.parse(review);
    const queue = await this.readQueue();
    const next = queue.map((proposal) => {
      if (proposal.proposalId !== parsedReview.proposalId) {
        return proposal;
      }

      return {
        ...proposal,
        status: parsedReview.status,
        updatedAt: parsedReview.reviewedAt,
        decisionNote: parsedReview.note ?? proposal.decisionNote
      };
    });

    await writeJsonAtomically(this.path, ParameterProposalRecordArraySchema.parse(next));

    if (this.options.outcomeLedgerPath) {
      await appendJsonLine(this.options.outcomeLedgerPath, OutcomeReviewRecordSchema.parse(parsedReview));
    }
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
