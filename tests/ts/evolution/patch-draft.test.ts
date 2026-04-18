import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { generatePatchDraft } from '../../../src/evolution';

describe('generatePatchDraft', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('builds a YAML patch draft for up to three related allowlisted parameters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-evolution-patch-'));
    directories.push(root);
    const baselineConfigPath = join(root, 'new-token-v1.yaml');

    await copyFile('src/config/strategies/new-token-v1.yaml', baselineConfigPath);

    const result = await generatePatchDraft({
      proposalId: 'proposal-risk-1',
      baselineConfigPath,
      proposals: [
        {
          proposalId: 'prop-1',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-18T12:00:00.000Z',
          updatedAt: '2026-04-18T12:00:00.000Z',
          targetPath: 'lpConfig.minBinStep',
          oldValue: 100,
          proposedValue: 90,
          evidenceWindowHours: 24,
          sampleSize: 6,
          rationale: 'Lower bin-step candidates outperformed.',
          expectedImprovement: 'More productive pool coverage.',
          riskNote: 'Could admit noisier pools.',
          uncertaintyNote: 'Sample remains regime-bound.',
          patchable: true
        },
        {
          proposalId: 'prop-2',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-18T12:00:00.000Z',
          updatedAt: '2026-04-18T12:00:00.000Z',
          targetPath: 'lpConfig.solDepletionExitBins',
          oldValue: 60,
          proposedValue: 66,
          evidenceWindowHours: 24,
          sampleSize: 5,
          rationale: 'LP exits were too early.',
          expectedImprovement: 'Capture more upside before unwind.',
          riskNote: 'May hold underwater bins longer.',
          uncertaintyNote: 'Dependent on pool regime.',
          patchable: true
        }
      ]
    });

    expect(result.status).toBe('ready');
    expect(result.blockedReason).toBeUndefined();
    expect(parse(result.patchYaml ?? '')).toEqual({
      lpConfig: {
        minBinStep: 90,
        solDepletionExitBins: 66
      }
    });
    expect(result.metadata).toEqual(expect.objectContaining({
      proposalId: 'proposal-risk-1',
      proposalCount: 2
    }));
  });

  it('fails closed when the baseline config drifts before patch generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-evolution-patch-drift-'));
    directories.push(root);
    const baselineConfigPath = join(root, 'new-token-v1.yaml');

    await copyFile('src/config/strategies/new-token-v1.yaml', baselineConfigPath);
    await writeFile(
      baselineConfigPath,
      (await (await import('node:fs/promises')).readFile(baselineConfigPath, 'utf8'))
        .replace('minBinStep: 100', 'minBinStep: 120'),
      'utf8'
    );

    const result = await generatePatchDraft({
      proposalId: 'proposal-drift-1',
      baselineConfigPath,
      proposals: [
        {
          proposalId: 'prop-1',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-18T12:00:00.000Z',
          updatedAt: '2026-04-18T12:00:00.000Z',
          targetPath: 'lpConfig.minBinStep',
          oldValue: 100,
          proposedValue: 90,
          evidenceWindowHours: 24,
          sampleSize: 6,
          rationale: 'Lower bin-step candidates outperformed.',
          expectedImprovement: 'More productive pool coverage.',
          riskNote: 'Could admit noisier pools.',
          uncertaintyNote: 'Sample remains regime-bound.',
          patchable: true
        }
      ]
    });

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('baseline_drift');
    expect(result.patchYaml).toBeNull();
  });

  it('fails closed when the proposal set is broader than the safe patch budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-evolution-patch-broad-'));
    directories.push(root);
    const baselineConfigPath = join(root, 'new-token-v1.yaml');

    await copyFile('src/config/strategies/new-token-v1.yaml', baselineConfigPath);

    const result = await generatePatchDraft({
      proposalId: 'proposal-too-many-1',
      baselineConfigPath,
      proposals: [
        buildPatchableProposal('lpConfig.minBinStep', 100, 90),
        buildPatchableProposal('lpConfig.solDepletionExitBins', 60, 66),
        buildPatchableProposal('lpConfig.minVolume24hUsd', 100000, 90000),
        buildPatchableProposal('lpConfig.minFeeTvlRatio24h', 0, 0.01)
      ]
    });

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('too_many_changes');
  });

  it('fails closed when proposal evidence quality is below the patch-draft safety threshold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-evolution-patch-weak-'));
    directories.push(root);
    const baselineConfigPath = join(root, 'new-token-v1.yaml');

    await copyFile('src/config/strategies/new-token-v1.yaml', baselineConfigPath);

    const result = await generatePatchDraft({
      proposalId: 'proposal-weak-1',
      baselineConfigPath,
      proposals: [
        {
          proposalId: 'prop-weak',
          proposalKind: 'parameter',
          strategyId: 'new-token-v1',
          status: 'draft',
          createdAt: '2026-04-18T12:00:00.000Z',
          updatedAt: '2026-04-18T12:00:00.000Z',
          targetPath: 'filters.minLiquidityUsd',
          oldValue: 1000,
          proposedValue: 900,
          evidenceWindowHours: 24,
          sampleSize: 2,
          rationale: 'Very small sample suggested a lower floor.',
          expectedImprovement: 'Maybe capture more breakouts.',
          riskNote: 'Could admit noisier pools.',
          uncertaintyNote: 'Weak evidence.',
          analysisConfidence: 'low',
          supportingMetric: 0.4,
          patchable: true
        }
      ]
    });

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('insufficient_evidence');
    expect(result.patchYaml).toBeNull();
  });

  it('fails closed when regime or coverage scoring says the proposal is not patch-ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-evolution-patch-regime-'));
    directories.push(root);
    const baselineConfigPath = join(root, 'new-token-v1.yaml');

    await copyFile('src/config/strategies/new-token-v1.yaml', baselineConfigPath);

    const result = await generatePatchDraft({
      proposalId: 'proposal-regime-1',
      baselineConfigPath,
      proposals: [
        {
          proposalId: 'prop-regime',
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
          rationale: 'Evidence looked good but the active window was thin and unstable.',
          expectedImprovement: 'Capture more breakouts.',
          riskNote: 'Could admit noisier pools.',
          uncertaintyNote: 'Window quality is poor.',
          analysisConfidence: 'high',
          supportingMetric: 0.8,
          coverageScore: 0.46,
          regimeScore: 0.49,
          proposalReadinessScore: 0.5,
          patchable: true
        }
      ]
    });

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('insufficient_evidence');
    expect(result.patchYaml).toBeNull();
  });
});

function buildPatchableProposal(targetPath: string, oldValue: number, proposedValue: number) {
  return {
    proposalId: `prop-${targetPath}`,
    proposalKind: 'parameter' as const,
    strategyId: 'new-token-v1' as const,
    status: 'draft' as const,
    createdAt: '2026-04-18T12:00:00.000Z',
    updatedAt: '2026-04-18T12:00:00.000Z',
    targetPath,
    oldValue,
    proposedValue,
    evidenceWindowHours: 24,
    sampleSize: 4,
    rationale: 'Evidence-backed proposal.',
    expectedImprovement: 'Expected improvement.',
    riskNote: 'Known risk.',
    uncertaintyNote: 'Known uncertainty.',
    patchable: true
  };
}
