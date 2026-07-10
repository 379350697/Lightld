import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runEvolutionApproval } from '../../../src/cli/run-evolution-approval';
import { quarantineLegacyEvolutionDataset } from '../../../src/evolution/dataset-status';
import { resolveEvolutionPaths } from '../../../src/evolution/paths';

describe('runEvolutionApproval V1 quarantine', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('refuses to mutate a quarantined V1 proposal queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-approval-v1-quarantine-'));
    directories.push(root);
    const paths = resolveEvolutionPaths('new-token-v1', join(root, 'evolution'));
    await quarantineLegacyEvolutionDataset({
      strategyId: 'new-token-v1',
      stateRootDir: root,
      sealedAt: '2026-07-10T00:00:00.000Z'
    });

    await expect(runEvolutionApproval({
      strategyId: 'new-token-v1',
      stateRootDir: root,
      proposalId: 'legacy-proposal',
      action: 'approve'
    })).rejects.toThrow(/research_invalid_v1/i);
    await expect(access(paths.approvalQueuePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
