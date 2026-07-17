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

  it('accepts the current tighter-only paper variants and rejects a wider candidate universe at start', async () => {
    const acceptedRoot = join(process.cwd(), `.tmp-strategy-research-current-${process.pid}-${Date.now()}`);
    const rejectedRoot = join(process.cwd(), `.tmp-strategy-research-wide-${process.pid}-${Date.now()}`);
    roots.push(acceptedRoot, rejectedRoot);
    await Promise.all([mkdir(acceptedRoot, { recursive: true }), mkdir(rejectedRoot, { recursive: true })]);

    const acceptedSpecPath = join(acceptedRoot, 'experiment.yaml');
    await writeFile(acceptedSpecPath, [
      'experimentId: new-token-paper-20260717-b',
      'strategyId: new-token-v1',
      'positionSol: 0.1',
      'variants:',
      '  - variantId: quality-balanced',
      '    parameterPatch:',
      '      hardGates:',
      '        minLiquidityUsd: 5000',
      '      filters:',
      '        minLiquidityUsd: 5000',
      '      lpConfig:',
      '        minVolume24hUsd: 150000',
      '  - variantId: quality-strict',
      '    parameterPatch:',
      '      hardGates:',
      '        minLiquidityUsd: 15000',
      '      filters:',
      '        minLiquidityUsd: 15000',
      '      lpConfig:',
      '        minBinStep: 100',
      '        minVolume24hUsd: 250000',
      '  - variantId: fast-exit-low-impact',
      '    parameterPatch:',
      '      lpConfig:',
      '        stopLossNetPnlPct: 15',
      '        takeProfitNetPnlPct: 20',
      '      solRouteLimits:',
      '        maxImpactBps: 150'
    ].join('\n'), 'utf8');

    const accepted = await runStrategyResearchCli([
      'start', '--spec', acceptedSpecPath, '--state-root-dir', acceptedRoot
    ], {});
    expect(accepted.exitCode).toBe(0);
    expect(JSON.parse(accepted.output)).toMatchObject({
      status: 'active',
      experimentId: 'new-token-paper-20260717-b'
    });

    const rejectedSpecPath = join(rejectedRoot, 'experiment.yaml');
    await writeFile(rejectedSpecPath, [
      'experimentId: misleading-wide-universe',
      'strategyId: new-token-v1',
      'variants:',
      '  - variantId: lower-volume',
      '    parameterPatch:',
      '      lpConfig:',
      '        minVolume24hUsd: 99999'
    ].join('\n'), 'utf8');

    await expect(runStrategyResearchCli([
      'start', '--spec', rejectedSpecPath, '--state-root-dir', rejectedRoot
    ], {})).rejects.toThrow(/Set the baseline to the widest candidate filters/);
  });
});
