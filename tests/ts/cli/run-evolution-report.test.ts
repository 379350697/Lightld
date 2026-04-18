import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appendJsonLine } from '../../../src/journals/jsonl-writer';
import {
  parseRunEvolutionReportArgs,
  runEvolutionReport
} from '../../../src/cli/run-evolution-report';
import { resolveEvolutionPaths } from '../../../src/evolution';

describe('runEvolutionReport', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('parses args and writes report artifacts under the default strategy output root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-1',
      capturedAt: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 2,
      prefilteredCount: 2,
      postLpCount: 2,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-selected',
      selectedPoolAddress: 'pool-selected',
      blockedReason: '',
      candidates: [
        {
          sampleId: 'cand-selected',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-1',
          tokenMint: 'mint-selected',
          tokenSymbol: 'SAFE',
          poolAddress: 'pool-selected',
          liquidityUsd: 10000,
          holders: 120,
          safetyScore: 80,
          volume24h: 5000,
          feeTvlRatio24h: 0.12,
          binStep: 120,
          hasInventory: false,
          hasLpPosition: false,
          selected: true,
          selectionRank: 1,
          blockedReason: '',
          rejectionStage: 'none',
          runtimeMode: 'healthy',
          sessionPhase: 'active'
        },
        {
          sampleId: 'cand-breakout',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-1',
          tokenMint: 'mint-breakout',
          tokenSymbol: 'BRK',
          poolAddress: 'pool-breakout',
          liquidityUsd: 800,
          holders: 80,
          safetyScore: 75,
          volume24h: 6000,
          feeTvlRatio24h: 0.2,
          binStep: 120,
          hasInventory: false,
          hasLpPosition: false,
          selected: false,
          selectionRank: 2,
          blockedReason: 'min-liquidity',
          rejectionStage: 'selection',
          runtimeMode: 'healthy',
          sessionPhase: 'active'
        }
      ]
    });

    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-selected',
      trackedSince: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-selected',
      tokenSymbol: 'SAFE',
      poolAddress: 'pool-selected',
      observationAt: '2026-04-18T01:00:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.18,
      liquidityUsd: 10000,
      activeBinId: null,
      lowerBinId: null,
      upperBinId: null,
      binCount: null,
      fundedBinCount: null,
      solDepletedBins: null,
      unclaimedFeeSol: null,
      hasInventory: true,
      hasLpPosition: false,
      sourceReason: 'selected'
    });
    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-breakout',
      trackedSince: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-breakout',
      tokenSymbol: 'BRK',
      poolAddress: 'pool-breakout',
      observationAt: '2026-04-18T01:00:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.62,
      liquidityUsd: 12000,
      activeBinId: null,
      lowerBinId: null,
      upperBinId: null,
      binCount: null,
      fundedBinCount: null,
      solDepletedBins: null,
      unclaimedFeeSol: null,
      hasInventory: false,
      hasLpPosition: false,
      sourceReason: 'filtered_out'
    });

    const parsed = parseRunEvolutionReportArgs([
      '--state-root-dir',
      stateRootDir
    ]);

    expect(parsed.strategyId).toBe('new-token-v1');
    expect(parsed.stateRootDir).toBe(stateRootDir);

    const result = await runEvolutionReport(parsed);
    const reportJson = JSON.parse(await readFile(paths.reportJsonPath, 'utf8')) as {
      strategyId: string;
      parameterProposals: Array<{ targetPath: string }>;
    };

    expect(result.outputDir).toBe(paths.rootDir);
    expect(reportJson.strategyId).toBe('new-token-v1');
    expect(reportJson.parameterProposals).toEqual([
      expect.objectContaining({ targetPath: 'filters.minLiquidityUsd' })
    ]);
    await expect(readFile(paths.reportMarkdownPath, 'utf8')).resolves.toContain('# Evolution Report');
    await expect(readFile(paths.proposalCatalogPath, 'utf8')).resolves.toContain('filters.minLiquidityUsd');
  });
});
