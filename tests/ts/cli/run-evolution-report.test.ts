import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appendJsonLine } from '../../../src/journals/jsonl-writer';
import {
  parseRunEvolutionReportArgs,
  runEvolutionReport
} from '../../../src/cli/run-evolution-report';
import { ApprovalStore, resolveEvolutionPaths } from '../../../src/evolution';

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
    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-2',
      capturedAt: '2026-04-18T00:05:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 2,
      prefilteredCount: 2,
      postLpCount: 2,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-selected-2',
      selectedPoolAddress: 'pool-selected-2',
      blockedReason: '',
      candidates: [
        {
          sampleId: 'cand-selected-2',
          capturedAt: '2026-04-18T00:05:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-2',
          tokenMint: 'mint-selected-2',
          tokenSymbol: 'SAFE2',
          poolAddress: 'pool-selected-2',
          liquidityUsd: 12000,
          holders: 150,
          safetyScore: 82,
          volume24h: 6500,
          feeTvlRatio24h: 0.11,
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
          sampleId: 'cand-breakout-2',
          capturedAt: '2026-04-18T00:05:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-2',
          tokenMint: 'mint-breakout-2',
          tokenSymbol: 'BRK2',
          poolAddress: 'pool-breakout-2',
          liquidityUsd: 900,
          holders: 75,
          safetyScore: 77,
          volume24h: 7000,
          feeTvlRatio24h: 0.21,
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
    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-selected-2',
      trackedSince: '2026-04-18T00:05:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-selected-2',
      tokenSymbol: 'SAFE2',
      poolAddress: 'pool-selected-2',
      observationAt: '2026-04-18T01:05:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.2,
      liquidityUsd: 13000,
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
      watchId: 'watch-breakout-2',
      trackedSince: '2026-04-18T00:05:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-breakout-2',
      tokenSymbol: 'BRK2',
      poolAddress: 'pool-breakout-2',
      observationAt: '2026-04-18T01:05:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.7,
      liquidityUsd: 12500,
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
      counterfactualAnalysis: {
        summary: { eligibleCounterfactualSamples: number; positiveRelativeSamples: number };
        pathSummaries: Array<{ targetPath: string; outperformRate: number }>;
      };
      proposalReplays: Array<{ targetPath: string; admittedSampleCount: number }>;
      outcomeReplays: Array<{ targetPath: string; replayableSampleCount: number }>;
      proposalValidations: Array<{ targetPath: string; status: string }>;
      evidenceSnapshot: {
        strategyConfigPath: string;
        proposalIds: string[];
      };
    };
    const evidenceSnapshot = JSON.parse(await readFile(paths.evidenceSnapshotPath, 'utf8')) as {
      timeWindowLabel: string;
      sampleCounts: {
        candidateScans: number;
        poolDecisionSamples: number;
        watchlistSnapshots: number;
        outcomes: number;
      };
      strategyConfigPath: string;
      coverageScore: number;
      regimeScore: number;
      proposalReadinessScore: number;
      proposalIds: string[];
    };

    expect(result.outputDir).toBe(paths.rootDir);
    expect(reportJson.strategyId).toBe('new-token-v1');
    expect(reportJson.parameterProposals).toEqual([
      expect.objectContaining({ targetPath: 'filters.minLiquidityUsd' })
    ]);
    expect(reportJson.counterfactualAnalysis.summary).toMatchObject({
      eligibleCounterfactualSamples: 2,
      positiveRelativeSamples: 2
    });
    expect(reportJson.counterfactualAnalysis.pathSummaries).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        outperformRate: 1
      })
    ]);
    expect(reportJson.proposalValidations).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        status: 'mixed'
      })
    ]);
    expect(reportJson.proposalReplays).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        admittedSampleCount: 1
      })
    ]);
    expect(reportJson.outcomeReplays).toEqual([
      expect.objectContaining({
        targetPath: 'filters.minLiquidityUsd',
        replayableSampleCount: 0
      })
    ]);
    expect(reportJson.evidenceSnapshot.strategyConfigPath).toBe('src/config/strategies/new-token-v1.yaml');
    expect(evidenceSnapshot.timeWindowLabel).toBe('all-available');
    expect(evidenceSnapshot.sampleCounts).toEqual({
      candidateScans: 2,
      poolDecisionSamples: 4,
      watchlistSnapshots: 4,
      outcomes: 0
    });
    expect(evidenceSnapshot.coverageScore).toBeGreaterThan(0.6);
    expect(evidenceSnapshot.regimeScore).toBeGreaterThan(0.6);
    expect(evidenceSnapshot.proposalReadinessScore).toBeGreaterThan(0.6);
    expect(
      evidenceSnapshot.proposalIds.some((proposalId) => proposalId.startsWith('parameter:filters.minLiquidityUsd:'))
    ).toBe(true);
    await expect(readFile(paths.reportMarkdownPath, 'utf8')).resolves.toContain('Pool decision samples: 4');
    const derivedSamples = (await readFile(paths.poolDecisionSamplesPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as {
        tokenMint: string;
        futurePath: {
          latestValueSol: number | null;
          observationCount: number;
          bestWindowLabel: string | null;
          forwardValueByWindowLabel: Record<string, number | null>;
        };
        counterfactual: { selectedBaselineValueSol: number | null; outperformedSelectedBaseline: boolean | null };
      });
    expect(derivedSamples).toHaveLength(4);
    expect(derivedSamples.find((sample) => sample.tokenMint === 'mint-breakout')).toMatchObject({
      futurePath: {
        latestValueSol: 0.62,
        observationCount: 1,
        bestWindowLabel: '1h',
        forwardValueByWindowLabel: {
          '1h': 0.62
        }
      },
      counterfactual: {
        selectedBaselineValueSol: 0.18,
        outperformedSelectedBaseline: true
      }
    });
    await expect(readFile(paths.proposalCatalogPath, 'utf8')).resolves.toContain('filters.minLiquidityUsd');
    await expect(
      access(join(paths.patchDraftsDir, 'parameter_filters.minLiquidityUsd.yaml'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports custom evolution roots and explicit time-window/sample thresholds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-windowed-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const evolutionRootDir = join(root, 'custom-evolution');
    const paths = resolveEvolutionPaths('new-token-v1', evolutionRootDir);

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'old-scan',
      capturedAt: '2026-04-10T00:00:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 1,
      prefilteredCount: 1,
      postLpCount: 1,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-old',
      selectedPoolAddress: 'pool-old',
      blockedReason: '',
      candidates: [
        {
          sampleId: 'cand-old',
          capturedAt: '2026-04-10T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-old',
          tokenMint: 'mint-old',
          tokenSymbol: 'OLD',
          poolAddress: 'pool-old',
          liquidityUsd: 10000,
          holders: 10,
          safetyScore: 80,
          volume24h: 1000,
          feeTvlRatio24h: 0.1,
          binStep: 100,
          hasInventory: false,
          hasLpPosition: false,
          selected: true,
          selectionRank: 1,
          blockedReason: '',
          rejectionStage: 'none',
          runtimeMode: 'healthy',
          sessionPhase: 'active'
        }
      ],
    });

    const parsed = parseRunEvolutionReportArgs([
      '--state-root-dir',
      stateRootDir,
      '--evolution-root-dir',
      evolutionRootDir,
      '--minimum-sample-size',
      '3',
      '--since-hours',
      '2'
    ]);

    expect(parsed.evolutionRootDir).toBe(evolutionRootDir);
    expect(parsed.minimumSampleSize).toBe(3);
    expect(parsed.sinceHours).toBe(2);

    const result = await runEvolutionReport(parsed);
    const reportJson = JSON.parse(await readFile(paths.reportJsonPath, 'utf8')) as {
      noActionReasons: string[];
      evidenceSnapshot: {
        timeWindowLabel: string;
        sampleCounts: { candidateScans: number };
        coverageScore: number;
        regimeScore: number;
        proposalReadinessScore: number;
      };
    };

    expect(result.outputDir).toBe(paths.rootDir);
    expect(reportJson.evidenceSnapshot.timeWindowLabel).toBe('last-2h');
    expect(reportJson.evidenceSnapshot.sampleCounts.candidateScans).toBe(0);
    expect(reportJson.evidenceSnapshot.coverageScore).toBeLessThan(0.5);
    expect(reportJson.evidenceSnapshot.regimeScore).toBeLessThan(0.5);
    expect(reportJson.evidenceSnapshot.proposalReadinessScore).toBeLessThan(0.5);
    expect(reportJson.noActionReasons).toContain('insufficient_sample_size');
  });

  it('marks take-profit proposals as supported when outcome replay confirms post-exit headroom', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-outcome-replay-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-tp-1',
      capturedAt: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 1,
      prefilteredCount: 1,
      postLpCount: 1,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-tp',
      selectedPoolAddress: 'pool-tp',
      blockedReason: '',
      candidates: [
        {
          sampleId: 'cand-tp',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-tp-1',
          tokenMint: 'mint-tp',
          tokenSymbol: 'TP',
          poolAddress: 'pool-tp',
          liquidityUsd: 10000,
          holders: 120,
          safetyScore: 82,
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
        }
      ]
    });

    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-tp-1',
      trackedSince: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-tp',
      tokenSymbol: 'TP',
      poolAddress: 'pool-tp',
      observationAt: '2026-04-18T01:00:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.27,
      liquidityUsd: 12000,
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
      watchId: 'watch-tp-2',
      trackedSince: '2026-04-18T00:05:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-tp-2',
      tokenSymbol: 'TP2',
      poolAddress: 'pool-tp-2',
      observationAt: '2026-04-18T01:05:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.31,
      liquidityUsd: 13000,
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

    await appendJsonLine(paths.positionOutcomesPath, buildOutcomeRecord({
      cycleId: 'cycle-tp-1',
      tokenMint: 'mint-tp',
      tokenSymbol: 'TP',
      poolAddress: 'pool-tp',
      actualExitReason: 'take-profit-hit',
      maxObservedUpsidePct: 31,
      actualExitMetricValue: 0.2,
      exitMetrics: {
        requestedPositionSol: 0.15,
        quoteOutputSol: 0.2
      }
    }));
    await appendJsonLine(paths.positionOutcomesPath, buildOutcomeRecord({
      cycleId: 'cycle-tp-2',
      tokenMint: 'mint-tp-2',
      tokenSymbol: 'TP2',
      poolAddress: 'pool-tp-2',
      recordedAt: '2026-04-18T00:35:00.000Z',
      openedAt: '2026-04-18T00:05:00.000Z',
      closedAt: '2026-04-18T00:35:00.000Z',
      positionId: 'position-tp-2',
      actualExitReason: 'take-profit-hit',
      maxObservedUpsidePct: 28,
      actualExitMetricValue: 0.22,
      exitMetrics: {
        requestedPositionSol: 0.16,
        quoteOutputSol: 0.22
      }
    }));

    const result = await runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir
    });
    const reportJson = JSON.parse(await readFile(paths.reportJsonPath, 'utf8')) as {
      parameterProposals: Array<{ targetPath: string }>;
      outcomeReplays: Array<{ targetPath: string; replayableSampleCount: number; supportiveSampleCount: number }>;
      proposalValidations: Array<{ targetPath: string; status: string }>;
    };

    expect(result.outputDir).toBe(paths.rootDir);
    expect(reportJson.parameterProposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetPath: 'riskThresholds.takeProfitPct' })
      ])
    );
    expect(reportJson.outcomeReplays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: 'riskThresholds.takeProfitPct',
          replayableSampleCount: 2,
          supportiveSampleCount: 2
        })
      ])
    );
    expect(reportJson.proposalValidations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: 'riskThresholds.takeProfitPct',
          status: 'supported'
        })
      ])
    );
  });

  it('marks lp take-profit proposals as supported when lp outcome replay confirms additional pnl headroom', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-lp-outcome-replay-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-lp-tp-1',
      capturedAt: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 1,
      prefilteredCount: 1,
      postLpCount: 1,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-lp-tp',
      selectedPoolAddress: 'pool-lp-tp',
      blockedReason: '',
      candidates: [
        {
          sampleId: 'cand-lp-tp',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-lp-tp-1',
          tokenMint: 'mint-lp-tp',
          tokenSymbol: 'LPTP',
          poolAddress: 'pool-lp-tp',
          liquidityUsd: 12000,
          holders: 150,
          safetyScore: 83,
          volume24h: 6500,
          feeTvlRatio24h: 0.15,
          binStep: 120,
          hasInventory: false,
          hasLpPosition: true,
          selected: true,
          selectionRank: 1,
          blockedReason: '',
          rejectionStage: 'none',
          runtimeMode: 'healthy',
          sessionPhase: 'active'
        }
      ]
    });

    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-lp-tp-1',
      trackedSince: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-lp-tp',
      tokenSymbol: 'LPTP',
      poolAddress: 'pool-lp-tp',
      observationAt: '2026-04-18T01:00:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.29,
      liquidityUsd: 13000,
      activeBinId: 123,
      lowerBinId: 100,
      upperBinId: 140,
      binCount: 41,
      fundedBinCount: 20,
      solDepletedBins: 12,
      unclaimedFeeSol: 0.02,
      hasInventory: false,
      hasLpPosition: true,
      sourceReason: 'lp_position'
    });
    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-lp-tp-2',
      trackedSince: '2026-04-18T00:05:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-lp-tp-2',
      tokenSymbol: 'LPTP2',
      poolAddress: 'pool-lp-tp-2',
      observationAt: '2026-04-18T01:05:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.33,
      liquidityUsd: 13500,
      activeBinId: 124,
      lowerBinId: 100,
      upperBinId: 140,
      binCount: 41,
      fundedBinCount: 20,
      solDepletedBins: 10,
      unclaimedFeeSol: 0.03,
      hasInventory: false,
      hasLpPosition: true,
      sourceReason: 'lp_position'
    });

    await appendJsonLine(paths.positionOutcomesPath, buildOutcomeRecord({
      cycleId: 'cycle-lp-tp-1',
      tokenMint: 'mint-lp-tp',
      tokenSymbol: 'LPTP',
      poolAddress: 'pool-lp-tp',
      action: 'withdraw-lp',
      actualExitReason: 'lp-take-profit',
      actualExitMetricValue: 42,
      lpTakeProfitNetPnlPctAtEntry: 30,
      parameterSnapshot: {
        takeProfitPct: 20,
        stopLossPct: 12,
        lpEnabled: true,
        lpStopLossNetPnlPct: 20,
        lpTakeProfitNetPnlPct: 30,
        lpSolDepletionExitBins: 60,
        lpMinBinStep: 100,
        lpMinVolume24hUsd: 100000,
        lpMinFeeTvlRatio24h: 0,
        maxHoldHours: 10
      },
      exitMetrics: {
        requestedPositionSol: 0.18,
        lpCurrentValueSol: 0.22,
        lpNetPnlPct: 42,
        lpUnclaimedFeeSol: 0.01
      }
    }));
    await appendJsonLine(paths.positionOutcomesPath, buildOutcomeRecord({
      cycleId: 'cycle-lp-tp-2',
      tokenMint: 'mint-lp-tp-2',
      tokenSymbol: 'LPTP2',
      poolAddress: 'pool-lp-tp-2',
      recordedAt: '2026-04-18T00:35:00.000Z',
      openedAt: '2026-04-18T00:05:00.000Z',
      closedAt: '2026-04-18T00:35:00.000Z',
      positionId: 'position-lp-tp-2',
      action: 'withdraw-lp',
      actualExitReason: 'lp-take-profit',
      actualExitMetricValue: 39,
      lpTakeProfitNetPnlPctAtEntry: 30,
      parameterSnapshot: {
        takeProfitPct: 20,
        stopLossPct: 12,
        lpEnabled: true,
        lpStopLossNetPnlPct: 20,
        lpTakeProfitNetPnlPct: 30,
        lpSolDepletionExitBins: 60,
        lpMinBinStep: 100,
        lpMinVolume24hUsd: 100000,
        lpMinFeeTvlRatio24h: 0,
        maxHoldHours: 10
      },
      exitMetrics: {
        requestedPositionSol: 0.19,
        lpCurrentValueSol: 0.24,
        lpNetPnlPct: 39,
        lpUnclaimedFeeSol: 0.015
      }
    }));

    const result = await runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir
    });
    const reportJson = JSON.parse(await readFile(paths.reportJsonPath, 'utf8')) as {
      parameterProposals: Array<{ targetPath: string }>;
      outcomeReplays: Array<{ targetPath: string; replayableSampleCount: number; supportiveSampleCount: number }>;
      proposalValidations: Array<{ targetPath: string; status: string }>;
    };

    expect(result.outputDir).toBe(paths.rootDir);
    expect(reportJson.parameterProposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetPath: 'lpConfig.takeProfitNetPnlPct' })
      ])
    );
    expect(reportJson.outcomeReplays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: 'lpConfig.takeProfitNetPnlPct',
          replayableSampleCount: 2,
          supportiveSampleCount: 2
        })
      ])
    );
    expect(reportJson.proposalValidations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: 'lpConfig.takeProfitNetPnlPct',
          status: 'supported'
        })
      ])
    );
  });

  it('marks stop-loss proposals as supported when post-exit watchlist evidence confirms further downside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-stop-loss-replay-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-sl-1',
      capturedAt: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 1,
      prefilteredCount: 1,
      postLpCount: 1,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-sl-1',
      selectedPoolAddress: 'pool-sl-1',
      blockedReason: '',
      candidates: [
        {
          sampleId: 'cand-sl-1',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-sl-1',
          tokenMint: 'mint-sl-1',
          tokenSymbol: 'SL1',
          poolAddress: 'pool-sl-1',
          liquidityUsd: 10000,
          holders: 110,
          safetyScore: 80,
          volume24h: 5200,
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
        }
      ]
    });

    await appendJsonLine(paths.positionOutcomesPath, buildOutcomeRecord({
      cycleId: 'cycle-sl-1',
      tokenMint: 'mint-sl-1',
      tokenSymbol: 'SL1',
      poolAddress: 'pool-sl-1',
      actualExitReason: 'stop-loss-hit',
      stopLossPctAtEntry: 12,
      exitMetrics: {
        requestedPositionSol: 0.15,
        quoteOutputSol: 0.16
      }
    }));
    await appendJsonLine(paths.positionOutcomesPath, buildOutcomeRecord({
      cycleId: 'cycle-sl-2',
      tokenMint: 'mint-sl-2',
      tokenSymbol: 'SL2',
      poolAddress: 'pool-sl-2',
      recordedAt: '2026-04-18T00:35:00.000Z',
      openedAt: '2026-04-18T00:05:00.000Z',
      closedAt: '2026-04-18T00:35:00.000Z',
      positionId: 'position-sl-2',
      actualExitReason: 'stop-loss-hit',
      stopLossPctAtEntry: 12,
      exitMetrics: {
        requestedPositionSol: 0.15,
        quoteOutputSol: 0.16
      }
    }));

    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-sl-1',
      trackedSince: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-sl-1',
      tokenSymbol: 'SL1',
      poolAddress: 'pool-sl-1',
      observationAt: '2026-04-18T01:00:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.1,
      liquidityUsd: 11000,
      activeBinId: null,
      lowerBinId: null,
      upperBinId: null,
      binCount: null,
      fundedBinCount: null,
      solDepletedBins: null,
      unclaimedFeeSol: null,
      hasInventory: false,
      hasLpPosition: false,
      sourceReason: 'selected'
    });
    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-sl-2',
      trackedSince: '2026-04-18T00:05:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-sl-2',
      tokenSymbol: 'SL2',
      poolAddress: 'pool-sl-2',
      observationAt: '2026-04-18T01:05:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.15,
      liquidityUsd: 10800,
      activeBinId: null,
      lowerBinId: null,
      upperBinId: null,
      binCount: null,
      fundedBinCount: null,
      solDepletedBins: null,
      unclaimedFeeSol: null,
      hasInventory: false,
      hasLpPosition: false,
      sourceReason: 'selected'
    });

    const result = await runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir
    });
    const reportJson = JSON.parse(await readFile(paths.reportJsonPath, 'utf8')) as {
      parameterProposals: Array<{ targetPath: string }>;
      outcomeReplays: Array<{ targetPath: string; replayableSampleCount: number; supportiveSampleCount: number }>;
      proposalValidations: Array<{ targetPath: string; status: string }>;
    };

    expect(result.outputDir).toBe(paths.rootDir);
    expect(reportJson.parameterProposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetPath: 'riskThresholds.stopLossPct' })
      ])
    );
    expect(reportJson.outcomeReplays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: 'riskThresholds.stopLossPct',
          replayableSampleCount: 2,
          supportiveSampleCount: 1
        })
      ])
    );
    expect(reportJson.proposalValidations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: 'riskThresholds.stopLossPct',
          status: 'supported'
        })
      ])
    );
  });

  it('marks lp stop-loss proposals as supported when post-exit lp watchlist evidence confirms further downside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-lp-stop-loss-replay-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-lp-sl-1',
      capturedAt: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 1,
      prefilteredCount: 1,
      postLpCount: 1,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-lp-sl-1',
      selectedPoolAddress: 'pool-lp-sl-1',
      blockedReason: '',
      candidates: [
        {
          sampleId: 'cand-lp-sl-1',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-lp-sl-1',
          tokenMint: 'mint-lp-sl-1',
          tokenSymbol: 'LPS1',
          poolAddress: 'pool-lp-sl-1',
          liquidityUsd: 12000,
          holders: 118,
          safetyScore: 82,
          volume24h: 5400,
          feeTvlRatio24h: 0.13,
          binStep: 120,
          hasInventory: false,
          hasLpPosition: true,
          selected: true,
          selectionRank: 1,
          blockedReason: '',
          rejectionStage: 'none',
          runtimeMode: 'healthy',
          sessionPhase: 'active'
        }
      ]
    });

    await appendJsonLine(paths.positionOutcomesPath, buildOutcomeRecord({
      cycleId: 'cycle-lp-sl-1',
      tokenMint: 'mint-lp-sl-1',
      tokenSymbol: 'LPS1',
      poolAddress: 'pool-lp-sl-1',
      action: 'withdraw-lp',
      actualExitReason: 'lp-stop-loss',
      lpStopLossNetPnlPctAtEntry: 20,
      actualExitMetricValue: -24,
      parameterSnapshot: {
        takeProfitPct: 20,
        stopLossPct: 12,
        lpEnabled: true,
        lpStopLossNetPnlPct: 20,
        lpTakeProfitNetPnlPct: 30,
        lpSolDepletionExitBins: 60,
        lpMinBinStep: 100,
        lpMinVolume24hUsd: 100000,
        lpMinFeeTvlRatio24h: 0,
        maxHoldHours: 10
      },
      exitMetrics: {
        requestedPositionSol: 0.15,
        lpCurrentValueSol: 0.08,
        lpNetPnlPct: -24,
        lpUnclaimedFeeSol: 0.01
      }
    }));
    await appendJsonLine(paths.positionOutcomesPath, buildOutcomeRecord({
      cycleId: 'cycle-lp-sl-2',
      tokenMint: 'mint-lp-sl-2',
      tokenSymbol: 'LPS2',
      poolAddress: 'pool-lp-sl-2',
      recordedAt: '2026-04-18T00:35:00.000Z',
      openedAt: '2026-04-18T00:05:00.000Z',
      closedAt: '2026-04-18T00:35:00.000Z',
      positionId: 'position-lp-sl-2',
      action: 'withdraw-lp',
      actualExitReason: 'lp-stop-loss',
      lpStopLossNetPnlPctAtEntry: 20,
      actualExitMetricValue: -21,
      parameterSnapshot: {
        takeProfitPct: 20,
        stopLossPct: 12,
        lpEnabled: true,
        lpStopLossNetPnlPct: 20,
        lpTakeProfitNetPnlPct: 30,
        lpSolDepletionExitBins: 60,
        lpMinBinStep: 100,
        lpMinVolume24hUsd: 100000,
        lpMinFeeTvlRatio24h: 0,
        maxHoldHours: 10
      },
      exitMetrics: {
        requestedPositionSol: 0.15,
        lpCurrentValueSol: 0.08,
        lpNetPnlPct: -21,
        lpUnclaimedFeeSol: 0.01
      }
    }));

    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-lp-sl-1',
      trackedSince: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-lp-sl-1',
      tokenSymbol: 'LPS1',
      poolAddress: 'pool-lp-sl-1',
      observationAt: '2026-04-18T01:00:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.04,
      liquidityUsd: 11200,
      activeBinId: 123,
      lowerBinId: 100,
      upperBinId: 140,
      binCount: 41,
      fundedBinCount: 20,
      solDepletedBins: 68,
      unclaimedFeeSol: 0.01,
      hasInventory: false,
      hasLpPosition: true,
      sourceReason: 'selected'
    });
    await appendJsonLine(paths.watchlistSnapshotsPath, {
      watchId: 'watch-lp-sl-2',
      trackedSince: '2026-04-18T00:05:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-lp-sl-2',
      tokenSymbol: 'LPS2',
      poolAddress: 'pool-lp-sl-2',
      observationAt: '2026-04-18T01:05:00.000Z',
      windowLabel: '1h',
      currentValueSol: 0.07,
      liquidityUsd: 11000,
      activeBinId: 124,
      lowerBinId: 100,
      upperBinId: 140,
      binCount: 41,
      fundedBinCount: 20,
      solDepletedBins: 65,
      unclaimedFeeSol: 0.01,
      hasInventory: false,
      hasLpPosition: true,
      sourceReason: 'selected'
    });

    const result = await runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir
    });
    const reportJson = JSON.parse(await readFile(paths.reportJsonPath, 'utf8')) as {
      parameterProposals: Array<{ targetPath: string }>;
      outcomeReplays: Array<{ targetPath: string; replayableSampleCount: number; supportiveSampleCount: number }>;
      proposalValidations: Array<{ targetPath: string; status: string }>;
    };

    expect(result.outputDir).toBe(paths.rootDir);
    expect(reportJson.parameterProposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetPath: 'lpConfig.stopLossNetPnlPct' })
      ])
    );
    expect(reportJson.outcomeReplays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: 'lpConfig.stopLossNetPnlPct',
          replayableSampleCount: 2,
          supportiveSampleCount: 1
        })
      ])
    );
    expect(reportJson.proposalValidations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: 'lpConfig.stopLossNetPnlPct',
          status: 'supported'
        })
      ])
    );
  });

  it('marks approved proposals as needs_more_data when the live config has not actually moved to the proposed value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-review-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));
    const approvalStore = new ApprovalStore(paths.approvalQueuePath, {
      decisionLogPath: paths.approvalHistoryPath,
      outcomeLedgerPath: paths.outcomeLedgerPath
    });

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-review-1',
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
          cycleId: 'cycle-r1',
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
          cycleId: 'cycle-r1',
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

    await approvalStore.upsertProposal({
      proposalId: 'approved-liquidity-cut',
      proposalKind: 'parameter',
      strategyId: 'new-token-v1',
      status: 'approved',
      createdAt: '2026-04-18T02:00:00.000Z',
      updatedAt: '2026-04-18T02:00:00.000Z',
      targetPath: 'filters.minLiquidityUsd',
      oldValue: 1000,
      proposedValue: 900,
      evidenceWindowHours: 24,
      sampleSize: 2,
      rationale: 'Approved for live observation.',
      expectedImprovement: 'Capture more breakouts.',
      riskNote: 'Known risk.',
      uncertaintyNote: 'Known uncertainty.',
      patchable: true,
      decidedAt: '2026-04-18T03:00:00.000Z'
    });

    await runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir
    });

    const reviewedQueue = await approvalStore.readQueue();
    const outcomeLedger = await approvalStore.readOutcomeLedger();

    expect(reviewedQueue).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proposalId: 'approved-liquidity-cut',
        status: 'needs_more_data'
      })
    ]));
    expect(outcomeLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proposalId: 'approved-liquidity-cut',
        status: 'needs_more_data',
        observedMetrics: expect.objectContaining({
          appliedConfigMatches: false
        })
      })
    ]));
  });

  it('marks approved proposals as confirmed once the live config matches the approved parameter value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-confirmed-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));
    const approvalStore = new ApprovalStore(paths.approvalQueuePath, {
      decisionLogPath: paths.approvalHistoryPath,
      outcomeLedgerPath: paths.outcomeLedgerPath
    });

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-review-1',
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
          cycleId: 'cycle-r1',
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
          cycleId: 'cycle-r1',
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
    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-review-2',
      capturedAt: '2026-04-18T06:00:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 2,
      prefilteredCount: 2,
      postLpCount: 2,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-selected-post',
      selectedPoolAddress: 'pool-selected-post',
      blockedReason: '',
      candidates: [
        {
          sampleId: 'cand-selected-post',
          capturedAt: '2026-04-18T06:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-r2',
          tokenMint: 'mint-selected-post',
          tokenSymbol: 'SAFE2',
          poolAddress: 'pool-selected-post',
          liquidityUsd: 12000,
          holders: 135,
          safetyScore: 81,
          volume24h: 5600,
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
          sampleId: 'cand-breakout-post',
          capturedAt: '2026-04-18T06:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-r2',
          tokenMint: 'mint-breakout-post',
          tokenSymbol: 'BRK2',
          poolAddress: 'pool-breakout-post',
          liquidityUsd: 850,
          holders: 85,
          safetyScore: 77,
          volume24h: 6200,
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
      watchId: 'watch-selected-post',
      trackedSince: '2026-04-18T06:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-selected-post',
      tokenSymbol: 'SAFE2',
      poolAddress: 'pool-selected-post',
      observationAt: '2026-04-18T10:00:00.000Z',
      windowLabel: '4h',
      currentValueSol: 0.2,
      liquidityUsd: 13000,
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
      watchId: 'watch-breakout-post',
      trackedSince: '2026-04-18T06:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-breakout-post',
      tokenSymbol: 'BRK2',
      poolAddress: 'pool-breakout-post',
      observationAt: '2026-04-18T10:00:00.000Z',
      windowLabel: '4h',
      currentValueSol: 0.72,
      liquidityUsd: 12600,
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

    await approvalStore.upsertProposal({
      proposalId: 'approved-liquidity-cut-confirmed',
      proposalKind: 'parameter',
      strategyId: 'new-token-v1',
      status: 'approved',
      createdAt: '2026-04-18T02:00:00.000Z',
      updatedAt: '2026-04-18T02:00:00.000Z',
      targetPath: 'filters.minLiquidityUsd',
      oldValue: 1000,
      proposedValue: 900,
      evidenceWindowHours: 24,
      sampleSize: 2,
      rationale: 'Approved for live observation.',
      expectedImprovement: 'Capture more breakouts.',
      riskNote: 'Known risk.',
      uncertaintyNote: 'Known uncertainty.',
      patchable: true,
      decidedAt: '2026-04-18T03:00:00.000Z'
    });

    await runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir,
      currentValuesOverride: {
        'filters.minLiquidityUsd': 900
      }
    });

    const reviewedQueue = await approvalStore.readQueue();
    const outcomeLedger = await approvalStore.readOutcomeLedger();

    expect(reviewedQueue).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proposalId: 'approved-liquidity-cut-confirmed',
        status: 'confirmed'
      })
    ]));
    expect(outcomeLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proposalId: 'approved-liquidity-cut-confirmed',
        status: 'confirmed',
        observedMetrics: expect.objectContaining({
          appliedConfigMatches: true,
          approvalAgeHours: expect.any(Number),
          reviewWindowHours: expect.any(Number),
          maxObservedWindowHours: expect.any(Number)
        })
      })
    ]));
  });

  it('keeps approved proposals in needs_more_data when the matching evidence exists only before approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-pre-approval-only-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));
    const approvalStore = new ApprovalStore(paths.approvalQueuePath, {
      decisionLogPath: paths.approvalHistoryPath,
      outcomeLedgerPath: paths.outcomeLedgerPath
    });

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-pre-only',
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
          sampleId: 'cand-selected-pre',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-pre-only',
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
          sampleId: 'cand-breakout-pre',
          capturedAt: '2026-04-18T00:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-pre-only',
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
      watchId: 'watch-selected-pre',
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
      watchId: 'watch-breakout-pre',
      trackedSince: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-breakout',
      tokenSymbol: 'BRK',
      poolAddress: 'pool-breakout',
      observationAt: '2026-04-18T04:00:00.000Z',
      windowLabel: '4h',
      currentValueSol: 0.7,
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

    await approvalStore.upsertProposal({
      proposalId: 'approved-liquidity-cut-pre-only',
      proposalKind: 'parameter',
      strategyId: 'new-token-v1',
      status: 'approved',
      createdAt: '2026-04-18T05:00:00.000Z',
      updatedAt: '2026-04-18T05:00:00.000Z',
      targetPath: 'filters.minLiquidityUsd',
      oldValue: 1000,
      proposedValue: 900,
      evidenceWindowHours: 24,
      sampleSize: 2,
      rationale: 'Approved for live observation.',
      expectedImprovement: 'Capture more breakouts.',
      riskNote: 'Known risk.',
      uncertaintyNote: 'Known uncertainty.',
      patchable: true,
      decidedAt: '2026-04-18T05:00:00.000Z'
    });

    await runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir,
      currentValuesOverride: {
        'filters.minLiquidityUsd': 900
      }
    });

    const outcomeLedger = await approvalStore.readOutcomeLedger();

    expect(outcomeLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proposalId: 'approved-liquidity-cut-pre-only',
        status: 'needs_more_data',
        observedMetrics: expect.objectContaining({
          appliedConfigMatches: true,
          postApprovalCandidateScans: 0,
          postApprovalWatchlistSnapshots: 0,
          maxObservedWindowHours: 0
        })
      })
    ]));
  });

  it('rejects an approved proposal when post-approval evidence now supports the opposite direction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-evolution-report-opposite-'));
    directories.push(root);
    const stateRootDir = join(root, 'state');
    const paths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));
    const approvalStore = new ApprovalStore(paths.approvalQueuePath, {
      decisionLogPath: paths.approvalHistoryPath,
      outcomeLedgerPath: paths.outcomeLedgerPath
    });

    await approvalStore.upsertProposal({
      proposalId: 'approved-liquidity-cut-opposite',
      proposalKind: 'parameter',
      strategyId: 'new-token-v1',
      status: 'approved',
      createdAt: '2026-04-18T02:00:00.000Z',
      updatedAt: '2026-04-18T02:00:00.000Z',
      targetPath: 'filters.minLiquidityUsd',
      oldValue: 1000,
      proposedValue: 900,
      evidenceWindowHours: 24,
      sampleSize: 3,
      rationale: 'Approved for live observation.',
      expectedImprovement: 'Capture more breakouts.',
      riskNote: 'Known risk.',
      uncertaintyNote: 'Known uncertainty.',
      patchable: true,
      decidedAt: '2026-04-18T02:00:00.000Z'
    });

    await appendJsonLine(paths.candidateScansPath, {
      scanId: 'scan-opposite-1',
      capturedAt: '2026-04-18T06:00:00.000Z',
      strategyId: 'new-token-v1',
      poolCount: 2,
      prefilteredCount: 2,
      postLpCount: 2,
      postSafetyCount: 1,
      eligibleSelectionCount: 1,
      scanWindowOpen: true,
      activePositionsCount: 0,
      selectedTokenMint: 'mint-breakout',
      selectedPoolAddress: 'pool-breakout',
      blockedReason: '',
      candidates: [
        {
          sampleId: 'cand-selected-opposite',
          capturedAt: '2026-04-18T06:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-opposite-1',
          tokenMint: 'mint-breakout',
          tokenSymbol: 'BRK',
          poolAddress: 'pool-breakout',
          liquidityUsd: 1500,
          holders: 120,
          safetyScore: 82,
          volume24h: 6200,
          feeTvlRatio24h: 0.18,
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
          sampleId: 'cand-filtered-opposite',
          capturedAt: '2026-04-18T06:00:00.000Z',
          strategyId: 'new-token-v1',
          cycleId: 'cycle-opposite-1',
          tokenMint: 'mint-filtered-bad',
          tokenSymbol: 'BAD',
          poolAddress: 'pool-filtered-bad',
          liquidityUsd: 800,
          holders: 40,
          safetyScore: 68,
          volume24h: 3000,
          feeTvlRatio24h: 0.05,
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
      watchId: 'watch-selected-opposite',
      trackedSince: '2026-04-18T06:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-breakout',
      tokenSymbol: 'BRK',
      poolAddress: 'pool-breakout',
      observationAt: '2026-04-18T10:00:00.000Z',
      windowLabel: '4h',
      currentValueSol: 0.78,
      liquidityUsd: 15000,
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
      watchId: 'watch-filtered-opposite',
      trackedSince: '2026-04-18T06:00:00.000Z',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-filtered-bad',
      tokenSymbol: 'BAD',
      poolAddress: 'pool-filtered-bad',
      observationAt: '2026-04-18T10:00:00.000Z',
      windowLabel: '4h',
      currentValueSol: 0.08,
      liquidityUsd: 1000,
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

    await runEvolutionReport({
      strategyId: 'new-token-v1',
      stateRootDir,
      currentValuesOverride: {
        'filters.minLiquidityUsd': 900
      }
    });

    const reviewedQueue = await approvalStore.readQueue();
    const outcomeLedger = await approvalStore.readOutcomeLedger();

    expect(reviewedQueue).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proposalId: 'approved-liquidity-cut-opposite',
        status: 'rejected'
      })
    ]));
    expect(outcomeLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proposalId: 'approved-liquidity-cut-opposite',
        status: 'rejected',
        observedMetrics: expect.objectContaining({
          appliedConfigMatches: true,
          postApprovalCandidateScans: 1,
          postApprovalWatchlistSnapshots: 2,
          maxObservedWindowHours: 4
        })
      })
    ]));
  });
});

function buildOutcomeRecord(overrides: Record<string, unknown>) {
  return {
    cycleId: 'cycle-1',
    strategyId: 'new-token-v1',
    recordedAt: '2026-04-18T00:30:00.000Z',
    tokenMint: 'mint-tp',
    tokenSymbol: 'TP',
    poolAddress: 'pool-tp',
    runtimeMode: 'healthy',
    sessionPhase: 'active',
    positionId: 'position-tp-1',
    action: 'dca-out',
    actualExitReason: 'take-profit-hit',
    openedAt: '2026-04-18T00:00:00.000Z',
    closedAt: '2026-04-18T00:30:00.000Z',
    entrySol: 0.15,
    maxObservedUpsidePct: 31,
    maxObservedDrawdownPct: 0,
    actualExitMetricValue: 0.2,
    takeProfitPctAtEntry: 20,
    stopLossPctAtEntry: 12,
    lpStopLossNetPnlPctAtEntry: 20,
    lpTakeProfitNetPnlPctAtEntry: 30,
    solDepletionExitBinsAtEntry: 60,
    minBinStepAtEntry: 100,
    liveOrderSubmitted: true,
    parameterSnapshot: {
      takeProfitPct: 20,
      stopLossPct: 12,
      lpEnabled: false,
      maxHoldHours: 10
    },
    exitMetrics: {
      requestedPositionSol: 0.15,
      quoteOutputSol: 0.2
    },
    ...overrides
  };
}
