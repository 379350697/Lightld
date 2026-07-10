import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PROFESSIONAL_EVOLUTION_MINIMUM_SAMPLE_SIZE,
  parseRunEvolutionReportArgs,
  resolveProfessionalEvolutionMinimumSampleSize,
  runEvolutionReport
} from '../../../src/cli/run-evolution-report';
import { resolveEvolutionPaths } from '../../../src/evolution/paths';

describe('runEvolutionReport V1 quarantine', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('parses the explicit forensics flag', () => {
    expect(parseRunEvolutionReportArgs(['--forensics-allow-v1'])).toMatchObject({
      forensicsAllowV1: true
    });
  });

  it('raises requested sample thresholds below the professional effective gate', () => {
    expect(parseRunEvolutionReportArgs([
      '--minimum-sample-size',
      '1'
    ])).toMatchObject({
      minimumSampleSize: 1
    });
    expect(resolveProfessionalEvolutionMinimumSampleSize(1)).toBe(PROFESSIONAL_EVOLUTION_MINIMUM_SAMPLE_SIZE);
    expect(resolveProfessionalEvolutionMinimumSampleSize(750)).toBe(750);
  });

  it('rejects legacy evidence by default before writing report artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-report-v1-reject-'));
    directories.push(root);
    const paths = resolveEvolutionPaths('new-token-v1', join(root, 'evolution'));

    await expect(runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir: root
    })).rejects.toThrow(/forensics-allow-v1/i);
    await expect(access(paths.reportJsonPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns read-only diagnostics in forensics mode and never emits proposals or files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-report-v1-forensics-'));
    directories.push(root);
    const paths = resolveEvolutionPaths('new-token-v1', join(root, 'evolution'));

    const result = await runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir: root,
      forensicsAllowV1: true
    });

    expect(result).toMatchObject({
      outputDir: paths.rootDir,
      readOnly: true,
      datasetStatus: 'research_invalid_v1',
      report: {
        evidenceSnapshot: {
          proposalReadinessScore: 0,
          proposalIds: []
        },
        parameterProposals: [],
        systemProposals: [],
        proposalValidations: [],
        proposalReplays: [],
        outcomeReplays: []
      }
    });
    await expect(access(paths.reportJsonPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(paths.proposalCatalogPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(paths.approvalQueuePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
