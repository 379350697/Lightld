import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DatasetStatusStore,
  buildLegacyDatasetStatus,
  quarantineLegacyEvolutionDataset
} from '../../../src/evolution/dataset-status';
import { loadEvolutionEvidence } from '../../../src/evolution/evidence-loader';
import { resolveEvolutionPaths } from '../../../src/evolution/paths';

describe('legacy dataset quarantine', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('builds the fixed invalid V1 policy and inventories legacy artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-dataset-status-'));
    directories.push(root);
    const paths = resolveEvolutionPaths('new-token-v1', root);
    await mkdir(paths.rootDir, { recursive: true });
    await writeFile(paths.candidateScansPath, '{}\n', 'utf8');

    const status = await buildLegacyDatasetStatus({
      strategyId: 'new-token-v1',
      stateRootDir: join(root, '..', 'state'),
      evolutionRootDir: root,
      sealedAt: '2026-07-10T00:00:00.000Z'
    });

    expect(status).toMatchObject({
      schemaVersion: 1,
      researchStatus: 'invalid',
      immutable: true,
      allowedUses: ['forensics', 'operations'],
      forbiddenUses: ['parameter_selection', 'pnl_claim', 'training', 'statistical_validation']
    });
    expect(status.artifacts).toContainEqual(expect.objectContaining({
      kind: 'candidate_scans',
      path: paths.candidateScansPath,
      present: true
    }));
  });

  it('seals dataset-status.json once and refuses conflicting replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-dataset-status-store-'));
    directories.push(root);
    const statusPath = join(root, 'dataset-status.json');
    const store = new DatasetStatusStore(statusPath);
    const original = await buildLegacyDatasetStatus({
      strategyId: 'new-token-v1',
      stateRootDir: root,
      evolutionRootDir: join(root, 'evolution'),
      sealedAt: '2026-07-10T00:00:00.000Z'
    });

    await store.seal(original);
    await expect(store.seal(original)).resolves.toEqual(original);
    await expect(store.seal({ ...original, sealedAt: '2026-07-11T00:00:00.000Z' }))
      .rejects.toThrow(/immutable/i);
    expect(JSON.parse(await readFile(statusPath, 'utf8'))).toEqual(original);
  });

  it('writes the quarantine marker beside the strategy evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-quarantine-command-'));
    directories.push(root);

    const result = await quarantineLegacyEvolutionDataset({
      strategyId: 'new-token-v1',
      stateRootDir: root,
      sealedAt: '2026-07-10T00:00:00.000Z'
    });

    expect(result.statusPath).toBe(
      resolveEvolutionPaths('new-token-v1', join(root, 'evolution')).datasetStatusPath
    );
    expect(JSON.parse(await readFile(result.statusPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      researchStatus: 'invalid'
    });
    await expect(quarantineLegacyEvolutionDataset({
      strategyId: 'new-token-v1',
      stateRootDir: root,
      sealedAt: '2026-07-11T00:00:00.000Z'
    })).resolves.toEqual(result);
  });

  it('rejects the V1 evidence loader by default and permits explicit forensics only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-v1-loader-'));
    directories.push(root);
    const paths = resolveEvolutionPaths('new-token-v1', join(root, 'evolution'));

    await expect(loadEvolutionEvidence({
      strategyId: 'new-token-v1',
      stateRootDir: root
    })).rejects.toThrow(/forensics-allow-v1/i);

    await expect(loadEvolutionEvidence({
      strategyId: 'new-token-v1',
      stateRootDir: root,
      allowLegacyV1Forensics: true
    })).resolves.toEqual({
      candidateScans: [],
      watchlistSnapshots: [],
      outcomes: []
    });
    await expect(readFile(paths.datasetStatusPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
