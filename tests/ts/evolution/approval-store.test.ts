import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalStore } from '../../../src/evolution';

describe('ApprovalStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('persists proposal queue entries and applies approve/reject/defer decisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-evolution-approval-'));
    directories.push(root);
    const store = new ApprovalStore(join(root, 'approval-queue.json'));

    await store.upsertProposal(buildProposal('proposal-approve'));
    await store.upsertProposal(buildProposal('proposal-defer'));
    await store.upsertProposal(buildProposal('proposal-reject'));

    await store.applyDecision({
      proposalId: 'proposal-approve',
      action: 'approve',
      note: 'Looks safe to try.',
      decidedAt: '2026-04-18T13:00:00.000Z'
    });
    await store.applyDecision({
      proposalId: 'proposal-defer',
      action: 'defer',
      note: 'Need another day of samples.',
      decidedAt: '2026-04-18T13:05:00.000Z'
    });
    await store.applyDecision({
      proposalId: 'proposal-reject',
      action: 'reject',
      note: 'Patch would broaden risk too much.',
      decidedAt: '2026-04-18T13:10:00.000Z'
    });

    const queue = await store.readQueue();

    expect(queue).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proposalId: 'proposal-approve',
        status: 'approved'
      }),
      expect.objectContaining({
        proposalId: 'proposal-defer',
        status: 'deferred'
      }),
      expect.objectContaining({
        proposalId: 'proposal-reject',
        status: 'rejected'
      })
    ]));
  });
});

function buildProposal(proposalId: string) {
  return {
    proposalId,
    proposalKind: 'parameter' as const,
    strategyId: 'new-token-v1' as const,
    status: 'draft' as const,
    createdAt: '2026-04-18T12:00:00.000Z',
    updatedAt: '2026-04-18T12:00:00.000Z',
    targetPath: 'lpConfig.minBinStep',
    oldValue: 100,
    proposedValue: 90,
    evidenceWindowHours: 24,
    sampleSize: 4,
    rationale: 'Evidence-backed proposal.',
    expectedImprovement: 'Expected improvement.',
    riskNote: 'Known risk.',
    uncertaintyNote: 'Known uncertainty.',
    patchable: true
  };
}
