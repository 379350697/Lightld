import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseRunEvolutionApprovalArgs,
  runEvolutionApproval
} from '../../../src/cli/run-evolution-approval';
import { ApprovalStore, resolveEvolutionPaths } from '../../../src/evolution';

describe('runEvolutionApproval', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('parses args, updates the approval queue, and writes approved patch artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-approval-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));
    const store = new ApprovalStore(paths.approvalQueuePath);

    await store.upsertProposal({
      proposalId: 'parameter:lpConfig.minBinStep:2026-04-18T12:00:00.000Z',
      proposalKind: 'parameter',
      strategyId: 'new-token-v1',
      status: 'draft',
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
    });

    const parsed = parseRunEvolutionApprovalArgs([
      '--state-root-dir',
      stateRootDir,
      '--proposal-id',
      'parameter:lpConfig.minBinStep:2026-04-18T12:00:00.000Z',
      '--action',
      'approve',
      '--note',
      'Ship the draft patch.'
    ]);

    expect(parsed.action).toBe('approve');
    expect(parsed.proposalId).toBe('parameter:lpConfig.minBinStep:2026-04-18T12:00:00.000Z');

    const result = await runEvolutionApproval(parsed);
    const queueRaw = JSON.parse(await readFile(paths.approvalQueuePath, 'utf8')) as Array<{ status: string }>;
    const safeFileName = 'parameter_lpConfig.minBinStep_2026-04-18T12_00_00.000Z';

    expect(result.status).toBe('approved');
    expect(queueRaw[0].status).toBe('approved');
    await expect(
      readFile(join(paths.approvedPatchesDir, `${safeFileName}.yaml`), 'utf8')
    ).resolves.toContain('minBinStep: 90');
    await expect(
      readFile(join(paths.approvedPatchesDir, `${safeFileName}.meta.json`), 'utf8')
    ).resolves.toContain('"proposalId": "parameter:lpConfig.minBinStep:2026-04-18T12:00:00.000Z"');
  });
});
