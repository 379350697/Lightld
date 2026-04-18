import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';

import {
  ApprovalStore,
  ParameterProposalRecordArraySchema,
  analyzeFilterEvidence,
  analyzeOutcomeEvidence,
  generateEvolutionProposals,
  loadEvolutionEvidence,
  renderEvolutionReport,
  resolveEvolutionPaths
} from '../evolution/index.ts';
import { writeJsonAtomically } from '../runtime/atomic-file.ts';

export type RunEvolutionReportArgs = {
  strategyId: 'new-token-v1' | 'large-pool-v1';
  stateRootDir: string;
  mirrorPath?: string;
};

export function parseRunEvolutionReportArgs(argv: string[]): RunEvolutionReportArgs {
  const parsed: RunEvolutionReportArgs = {
    strategyId: 'new-token-v1',
    stateRootDir: 'state'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--strategy' && next && (next === 'new-token-v1' || next === 'large-pool-v1')) {
      parsed.strategyId = next;
      index += 1;
      continue;
    }

    if (current === '--state-root-dir' && next) {
      parsed.stateRootDir = next;
      index += 1;
      continue;
    }

    if (current === '--mirror-path' && next) {
      parsed.mirrorPath = next;
      index += 1;
    }
  }

  return parsed;
}

export async function runEvolutionReport(args: RunEvolutionReportArgs) {
  const paths = resolveEvolutionPaths(args.strategyId, join(args.stateRootDir, 'evolution'));
  const evidence = await loadEvolutionEvidence({
    strategyId: args.strategyId,
    stateRootDir: args.stateRootDir,
    mirrorPath: args.mirrorPath
  });
  const filterAnalysis = analyzeFilterEvidence({
    candidateScans: evidence.candidateScans,
    watchlistSnapshots: evidence.watchlistSnapshots,
    minimumSampleSize: 1
  });
  const outcomeAnalysis = analyzeOutcomeEvidence({
    outcomes: evidence.outcomes,
    watchlistSnapshots: evidence.watchlistSnapshots,
    minimumSampleSize: 1
  });
  const currentValues = await loadCurrentValues(args.strategyId);
  const proposals = generateEvolutionProposals({
    strategyId: args.strategyId,
    createdAt: new Date().toISOString(),
    currentValues,
    filterAnalysis,
    outcomeAnalysis
  });
  const rendered = renderEvolutionReport({
    strategyId: args.strategyId,
    generatedAt: new Date().toISOString(),
    evidenceCounts: {
      candidateScans: evidence.candidateScans.length,
      watchlistSnapshots: evidence.watchlistSnapshots.length,
      outcomes: evidence.outcomes.length
    },
    filterAnalysis,
    outcomeAnalysis,
    parameterProposals: proposals.parameterProposals,
    systemProposals: proposals.systemProposals,
    noActionReasons: proposals.noActionReasons
  });

  await writeJsonAtomically(paths.reportJsonPath, rendered.json);
  await writeFile(paths.reportMarkdownPath, `${rendered.markdown}\n`, 'utf8');
  await writeJsonAtomically(
    paths.proposalCatalogPath,
    ParameterProposalRecordArraySchema.parse([
      ...proposals.parameterProposals,
      ...proposals.systemProposals
    ])
  );

  const approvalStore = new ApprovalStore(paths.approvalQueuePath);
  const existingQueue = await approvalStore.readQueue();
  if (existingQueue.length === 0) {
    for (const proposal of [...proposals.parameterProposals, ...proposals.systemProposals]) {
      await approvalStore.upsertProposal(proposal);
    }
  }

  return {
    outputDir: paths.rootDir,
    report: rendered.json
  };
}

async function loadCurrentValues(strategyId: 'new-token-v1' | 'large-pool-v1') {
  const configPath = strategyId === 'new-token-v1'
    ? 'src/config/strategies/new-token-v1.yaml'
    : 'src/config/strategies/large-pool-v1.yaml';
  const config = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  const paths = [
    'filters.minLiquidityUsd',
    'riskThresholds.takeProfitPct',
    'riskThresholds.stopLossPct',
    'lpConfig.stopLossNetPnlPct',
    'lpConfig.takeProfitNetPnlPct',
    'lpConfig.solDepletionExitBins',
    'lpConfig.minBinStep',
    'lpConfig.minVolume24hUsd',
    'lpConfig.minFeeTvlRatio24h'
  ];

  return Object.fromEntries(paths.map((path) => [path, getPathValue(config, path)])) as Record<
    string,
    number | string | boolean | null | undefined
  >;
}

function getPathValue(root: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((value, segment) => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)[segment]
        : undefined
    ), root);
}
