import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runStrategyResearchCli } from '../../../src/cli/run-strategy-research.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('run:strategy-research', () => {
  it('runs start, status, exploratory analyze, export and stop without approval machinery', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-cli-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const specPath = join(root, 'experiment.yaml');
    await writeFile(specPath, [
      'experimentId: personal-test',
      'strategyId: new-token-v1',
      'positionSol: 0.1',
      'variants:',
      '  - variantId: safer-size',
      '    parameterPatch:',
      '      riskThresholds:',
      '        maxPositionSol: 0.1'
    ].join('\n'), 'utf8');

    const start = await runStrategyResearchCli(['start', '--spec', specPath, '--state-root-dir', root], {});
    expect(start.exitCode).toBe(0);
    expect(JSON.parse(start.output).status).toBe('active');

    const status = await runStrategyResearchCli(['status', '--state-root-dir', root], {});
    expect(JSON.parse(status.output).activeExperiment.experimentId).toBe('personal-test');

    const stopped = await runStrategyResearchCli(['stop', '--state-root-dir', root], {});
    expect(JSON.parse(stopped.output).status).toBe('stopped');

    const analysis = await runStrategyResearchCli(['analyze', '--state-root-dir', root], {});
    expect(JSON.parse(analysis.output).report.status).toBe('insufficient');

    const exported = await runStrategyResearchCli(['export', '--format', 'csv', '--state-root-dir', root], {});
    expect(JSON.parse(exported.output).rowCount).toBe(0);
  });
});
