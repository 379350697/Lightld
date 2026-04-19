import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const store = new ApprovalStore(paths.approvalQueuePath, {
      decisionLogPath: paths.approvalHistoryPath,
      outcomeLedgerPath: paths.outcomeLedgerPath
    });

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
    const decisionHistory = await store.readDecisionHistory();

    expect(result.status).toBe('approved');
    expect(queueRaw[0].status).toBe('approved');
    await expect(
      readFile(join(paths.approvedPatchesDir, `${safeFileName}.yaml`), 'utf8')
    ).resolves.toContain('minBinStep: 90');
    await expect(
      readFile(join(paths.approvedPatchesDir, `${safeFileName}.meta.json`), 'utf8')
    ).resolves.toContain('"proposalId": "parameter:lpConfig.minBinStep:2026-04-18T12:00:00.000Z"');
    expect(decisionHistory).toEqual([
      expect.objectContaining({
        proposalId: 'parameter:lpConfig.minBinStep:2026-04-18T12:00:00.000Z',
        action: 'approve',
        relatedReportPath: paths.reportJsonPath,
        generatedPatchDraftPath: join(paths.approvedPatchesDir, `${safeFileName}.yaml`)
      })
    ]);
  });

  it('does not write an approved patch artifact when the latest report marks the proposal validation as mixed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-approval-guarded-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));
    const store = new ApprovalStore(paths.approvalQueuePath, {
      decisionLogPath: paths.approvalHistoryPath,
      outcomeLedgerPath: paths.outcomeLedgerPath
    });

    await store.upsertProposal({
      proposalId: 'parameter:filters.minLiquidityUsd:2026-04-18T12:00:00.000Z',
      proposalKind: 'parameter',
      strategyId: 'new-token-v1',
      status: 'draft',
      createdAt: '2026-04-18T12:00:00.000Z',
      updatedAt: '2026-04-18T12:00:00.000Z',
      targetPath: 'filters.minLiquidityUsd',
      oldValue: 1000,
      proposedValue: 900,
      evidenceWindowHours: 24,
      sampleSize: 6,
      rationale: 'Evidence-backed proposal.',
      expectedImprovement: 'Expected improvement.',
      riskNote: 'Known risk.',
      uncertaintyNote: 'Known uncertainty.',
      analysisConfidence: 'high',
      supportingMetric: 0.8,
      coverageScore: 0.8,
      regimeScore: 0.8,
      proposalReadinessScore: 0.8,
      patchable: true
    });
    await writeFile(paths.reportJsonPath, JSON.stringify({
      proposalValidations: [
        {
          proposalId: 'parameter:filters.minLiquidityUsd:2026-04-18T12:00:00.000Z',
          targetPath: 'filters.minLiquidityUsd',
          status: 'mixed',
          note: 'Counterfactual evidence is too thin.',
          sampleCount: 2,
          outperformRate: 1,
          averageRelativeToSelectedBaselineSol: 0.47,
          recentSliceLabel: 'later-half',
          recentSliceSampleCount: 1,
          recentSliceOutperformRate: 1,
          recentSliceAverageRelativeToSelectedBaselineSol: 0.47
        }
      ]
    }, null, 2), 'utf8');

    const result = await runEvolutionApproval({
      strategyId: 'new-token-v1',
      stateRootDir,
      proposalId: 'parameter:filters.minLiquidityUsd:2026-04-18T12:00:00.000Z',
      action: 'approve'
    });
    const queueRaw = JSON.parse(await readFile(paths.approvalQueuePath, 'utf8')) as Array<{ decisionNote?: string }>;

    expect(result.status).toBe('approved');
    expect(result.patchPath).toBeUndefined();
    expect(result.patchBlockedNote).toContain('recent slice');
    expect(queueRaw[0].decisionNote).toContain('recent slice');
  });
});
