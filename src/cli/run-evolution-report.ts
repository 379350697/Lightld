import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';

import {
  ApprovalStore,
  type AnalysisNoActionReason,
  ParameterProposalRecordArraySchema,
  analyzeCounterfactualSamples,
  analyzeFilterEvidence,
  analyzeOutcomeEvidence,
  buildPoolDecisionSamples,
  buildEvolutionAnalysisContext,
  generatePatchDraft,
  type EvolutionEvidenceSnapshot,
  type ParameterProposalRecord,
  type ProposalValidationRecord,
  PoolDecisionSampleStore,
  replayParameterProposals,
  replayOutcomeProposals,
  validateParameterProposals,
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
  evolutionRootDir?: string;
  minimumSampleSize?: number;
  sinceHours?: number;
  currentValuesOverride?: Record<string, number | string | boolean | null | undefined>;
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
      continue;
    }

    if (current === '--evolution-root-dir' && next) {
      parsed.evolutionRootDir = next;
      index += 1;
      continue;
    }

    if (current === '--minimum-sample-size' && next) {
      const parsedValue = Number(next);
      if (Number.isFinite(parsedValue) && parsedValue > 0) {
        parsed.minimumSampleSize = Math.max(1, Math.round(parsedValue));
        index += 1;
      }
      continue;
    }

    if (current === '--since-hours' && next) {
      const parsedValue = Number(next);
      if (Number.isFinite(parsedValue) && parsedValue > 0) {
        parsed.sinceHours = parsedValue;
        index += 1;
      }
    }
  }

  return parsed;
}

export async function runEvolutionReport(args: RunEvolutionReportArgs) {
  const evolutionRootDir = args.evolutionRootDir ?? join(args.stateRootDir, 'evolution');
  const paths = resolveEvolutionPaths(args.strategyId, evolutionRootDir);
  const generatedAt = new Date().toISOString();
  const loadedEvidence = await loadEvolutionEvidence({
    strategyId: args.strategyId,
    stateRootDir: args.stateRootDir,
    mirrorPath: args.mirrorPath,
    evolutionRootDir
  });
  const evidence = filterEvidenceByTimeWindow(loadedEvidence, args.sinceHours, generatedAt);
  const minimumSampleSize = args.minimumSampleSize ?? 1;
  const filterAnalysis = analyzeFilterEvidence({
    candidateScans: evidence.candidateScans,
    watchlistSnapshots: evidence.watchlistSnapshots,
    minimumSampleSize
  });
  const outcomeAnalysis = analyzeOutcomeEvidence({
    outcomes: evidence.outcomes,
    watchlistSnapshots: evidence.watchlistSnapshots,
    minimumSampleSize
  });
  const analysisContext = buildEvolutionAnalysisContext({
    candidateScans: evidence.candidateScans.length,
    watchlistSnapshots: evidence.watchlistSnapshots.length,
    outcomes: evidence.outcomes.length,
    filterAnalysis,
    outcomeAnalysis
  });
  const approvalStore = new ApprovalStore(paths.approvalQueuePath, {
    decisionLogPath: paths.approvalHistoryPath,
    outcomeLedgerPath: paths.outcomeLedgerPath
  });
  const existingQueue = await approvalStore.readQueue();
  const existingOutcomeReviews = await approvalStore.readOutcomeLedger();
  const currentValues = {
    ...await loadCurrentValues(args.strategyId),
    ...(args.currentValuesOverride ?? {})
  };
  const proposals = generateEvolutionProposals({
    strategyId: args.strategyId,
    createdAt: generatedAt,
    currentValues,
    filterAnalysis,
    outcomeAnalysis,
    analysisContext,
    existingProposals: existingQueue,
    outcomeReviews: existingOutcomeReviews
  });
  const poolDecisionSamples = buildPoolDecisionSamples(evidence);
  const counterfactualAnalysis = analyzeCounterfactualSamples({
    samples: poolDecisionSamples,
    minimumSampleSize
  });
  const proposalReplays = replayParameterProposals({
    proposals: proposals.parameterProposals,
    samples: poolDecisionSamples
  });
  const outcomeReplays = replayOutcomeProposals({
    proposals: proposals.parameterProposals,
    outcomes: evidence.outcomes,
    watchlistSnapshots: evidence.watchlistSnapshots
  });
  const proposalValidations = validateParameterProposals({
    proposals: proposals.parameterProposals,
    counterfactualAnalysis,
    proposalReplays,
    outcomeReplays
  });
  const evidenceSnapshot = buildEvidenceSnapshot({
    strategyId: args.strategyId,
    generatedAt,
    evidenceCounts: {
      candidateScans: evidence.candidateScans.length,
      poolDecisionSamples: poolDecisionSamples.length,
      watchlistSnapshots: evidence.watchlistSnapshots.length,
      outcomes: evidence.outcomes.length
    },
    strategyConfigPath: strategyConfigPathFor(args.strategyId),
    timeWindowLabel: buildTimeWindowLabel(args.sinceHours),
    analysisContext,
    filterAnalysis,
    outcomeAnalysis,
    proposalIds: [
      ...proposals.parameterProposals.map((proposal) => proposal.proposalId),
      ...proposals.systemProposals.map((proposal) => proposal.proposalId)
    ]
  });
  const rendered = renderEvolutionReport({
    strategyId: args.strategyId,
    generatedAt,
    evidenceSnapshot,
    evidenceCounts: {
      candidateScans: evidence.candidateScans.length,
      poolDecisionSamples: poolDecisionSamples.length,
      watchlistSnapshots: evidence.watchlistSnapshots.length,
      outcomes: evidence.outcomes.length
    },
    filterAnalysis,
    outcomeAnalysis,
    counterfactualAnalysis,
    proposalValidations,
    proposalReplays,
    outcomeReplays,
    parameterProposals: proposals.parameterProposals,
    systemProposals: proposals.systemProposals,
    noActionReasons: proposals.noActionReasons
  });
  const poolDecisionSampleStore = new PoolDecisionSampleStore(paths.poolDecisionSamplesPath);

  await poolDecisionSampleStore.writeAll(poolDecisionSamples);
  await writeJsonAtomically(paths.evidenceSnapshotPath, evidenceSnapshot);
  await writeJsonAtomically(paths.reportJsonPath, rendered.json);
  await writeFile(paths.reportMarkdownPath, `${rendered.markdown}\n`, 'utf8');
  await writeJsonAtomically(
    paths.proposalCatalogPath,
    ParameterProposalRecordArraySchema.parse([
      ...proposals.parameterProposals,
      ...proposals.systemProposals
    ])
  );
  await emitPatchDrafts({
    patchDraftsDir: paths.patchDraftsDir,
    reportJsonPath: paths.reportJsonPath,
    baselineConfigPath: strategyConfigPathFor(args.strategyId),
    proposals: proposals.parameterProposals,
    proposalValidations
  });

  await reviewApprovedProposals({
    store: approvalStore,
    queue: existingQueue,
    evidence,
    minimumSampleSize,
    currentValues,
    reviewedAt: generatedAt
  });

  const existingProposalIds = new Set(existingQueue.map((proposal) => proposal.proposalId));
  for (const proposal of [...proposals.parameterProposals, ...proposals.systemProposals]) {
    if (!existingProposalIds.has(proposal.proposalId)) {
      await approvalStore.upsertProposal(proposal);
    }
  }

  return {
    outputDir: paths.rootDir,
    report: rendered.json
  };
}

async function emitPatchDrafts(input: {
  patchDraftsDir: string;
  reportJsonPath: string;
  baselineConfigPath: string;
  proposals: ParameterProposalRecord[];
  proposalValidations: ProposalValidationRecord[];
}) {
  if (input.proposals.length === 0) {
    return;
  }

  await mkdir(input.patchDraftsDir, { recursive: true });

  for (const proposal of input.proposals) {
    const patchDraft = await generatePatchDraft({
      proposalId: proposal.proposalId,
      baselineConfigPath: input.baselineConfigPath,
      proposals: [proposal],
      proposalValidations: input.proposalValidations
    });

    if (patchDraft.status !== 'ready' || !patchDraft.patchYaml) {
      continue;
    }

    const safeName = `parameter_${proposal.targetPath.replace(/[<>:"/\\|?*]/g, '_')}`;
    await writeFile(join(input.patchDraftsDir, `${safeName}.yaml`), `${patchDraft.patchYaml}\n`, 'utf8');
    await writeJsonAtomically(
      join(input.patchDraftsDir, `${safeName}.meta.json`),
        {
          ...patchDraft.metadata,
          proposalId: proposal.proposalId,
          reportPath: input.reportJsonPath
        }
      );
  }
}

function buildEvidenceSnapshot(input: {
  strategyId: 'new-token-v1' | 'large-pool-v1';
  generatedAt: string;
  evidenceCounts: EvolutionEvidenceSnapshot['sampleCounts'];
  strategyConfigPath: string;
  timeWindowLabel: string;
  analysisContext: {
    coverageScore: number;
    regimeScore: number;
    proposalReadinessScore: number;
    regimeLabels: string[];
    coverageBreakdown: EvolutionEvidenceSnapshot['coverageBreakdown'];
  };
  filterAnalysis: ReturnType<typeof analyzeFilterEvidence>;
  outcomeAnalysis: ReturnType<typeof analyzeOutcomeEvidence>;
  proposalIds: string[];
}): EvolutionEvidenceSnapshot {
  return {
    capturedAt: input.generatedAt,
    timeWindowLabel: input.timeWindowLabel,
    sampleCounts: input.evidenceCounts,
    strategyConfigPath: input.strategyConfigPath,
    coverageScore: input.analysisContext.coverageScore,
    regimeScore: input.analysisContext.regimeScore,
    proposalReadinessScore: input.analysisContext.proposalReadinessScore,
    coverageBreakdown: input.analysisContext.coverageBreakdown,
    regimeLabels: input.analysisContext.regimeLabels,
    headlineDiagnostics: [
      input.evidenceCounts.candidateScans === 0
        ? 'No evidence has been collected yet.'
        : `${input.filterAnalysis.summary.missedOpportunityCount} missed opportunities exceeded selected baseline.`,
      `${input.outcomeAnalysis.summary.matchedFollowThroughCount} outcome samples matched a tracked follow-through snapshot.`
    ],
    proposalIds: input.proposalIds
  };
}

async function loadCurrentValues(strategyId: 'new-token-v1' | 'large-pool-v1') {
  const configPath = strategyConfigPathFor(strategyId);
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

function strategyConfigPathFor(strategyId: 'new-token-v1' | 'large-pool-v1') {
  return strategyId === 'new-token-v1'
    ? 'src/config/strategies/new-token-v1.yaml'
    : 'src/config/strategies/large-pool-v1.yaml';
}

function filterEvidenceByTimeWindow(
  evidence: Awaited<ReturnType<typeof loadEvolutionEvidence>>,
  sinceHours: number | undefined,
  referenceTimeIso: string
) {
  if (!sinceHours || sinceHours <= 0) {
    return evidence;
  }

  const cutoffMs = Date.parse(referenceTimeIso) - sinceHours * 60 * 60 * 1000;

  return {
    candidateScans: evidence.candidateScans.filter((scan) => Date.parse(scan.capturedAt) >= cutoffMs),
    watchlistSnapshots: evidence.watchlistSnapshots.filter((snapshot) => Date.parse(snapshot.observationAt) >= cutoffMs),
    outcomes: evidence.outcomes.filter((outcome) => Date.parse(outcome.recordedAt) >= cutoffMs)
  };
}

function buildTimeWindowLabel(sinceHours?: number) {
  if (!sinceHours || sinceHours <= 0) {
    return 'all-available';
  }

  return `last-${Math.round(sinceHours)}h`;
}

async function reviewApprovedProposals(input: {
  store: ApprovalStore;
  queue: ParameterProposalRecord[];
  evidence: Awaited<ReturnType<typeof loadEvolutionEvidence>>;
  minimumSampleSize: number;
  currentValues: Record<string, number | string | boolean | null | undefined>;
  reviewedAt: string;
}) {
  const outcomeLedger = await input.store.readOutcomeLedger();
  const latestReviewByProposal = new Map<string, string>();

  for (const review of outcomeLedger) {
    const existing = latestReviewByProposal.get(review.proposalId);
    if (!existing || existing < review.reviewedAt) {
      latestReviewByProposal.set(review.proposalId, review.reviewedAt);
    }
  }

  for (const proposal of input.queue) {
    if (proposal.status !== 'approved') {
      continue;
    }

    const postApprovalEvidence = filterEvidenceSinceTimestamp(
      input.evidence,
      proposal.decidedAt ?? proposal.updatedAt ?? proposal.createdAt
    );
    const postApprovalFilterAnalysis = analyzeFilterEvidence({
      candidateScans: postApprovalEvidence.candidateScans,
      watchlistSnapshots: postApprovalEvidence.watchlistSnapshots,
      minimumSampleSize: input.minimumSampleSize
    });
    const postApprovalOutcomeAnalysis = analyzeOutcomeEvidence({
      outcomes: postApprovalEvidence.outcomes,
      watchlistSnapshots: postApprovalEvidence.watchlistSnapshots,
      minimumSampleSize: input.minimumSampleSize
    });
    const postApprovalAnalysisContext = buildEvolutionAnalysisContext({
      candidateScans: postApprovalEvidence.candidateScans.length,
      watchlistSnapshots: postApprovalEvidence.watchlistSnapshots.length,
      outcomes: postApprovalEvidence.outcomes.length,
      filterAnalysis: postApprovalFilterAnalysis,
      outcomeAnalysis: postApprovalOutcomeAnalysis
    });
    const postApprovalProposals = generateEvolutionProposals({
      strategyId: proposal.strategyId,
      createdAt: input.reviewedAt,
      currentValues: input.currentValues,
      filterAnalysis: postApprovalFilterAnalysis,
      outcomeAnalysis: postApprovalOutcomeAnalysis,
      analysisContext: postApprovalAnalysisContext
    });
    const matchedProposal = postApprovalProposals.parameterProposals.find(
      (currentProposal) => currentProposal.targetPath === proposal.targetPath
    );
    const reviewMetrics = buildProposalReviewMetrics({
      proposal,
      postApprovalEvidence,
      reviewedAt: input.reviewedAt
    });
    const review = deriveOutcomeReview({
      approvedProposal: proposal,
      currentProposal: matchedProposal,
      noActionReasons: relevantNoActionReasonsForProposal(
        proposal,
        postApprovalFilterAnalysis.noActionReasons,
        postApprovalOutcomeAnalysis.noActionReasons
      ),
      currentValue: input.currentValues[proposal.targetPath],
      reviewMetrics
    });
    const latestReviewedAt = latestReviewByProposal.get(proposal.proposalId);

    if (latestReviewedAt && latestReviewedAt >= input.reviewedAt) {
      continue;
    }

    await input.store.recordOutcomeReview({
      proposalId: proposal.proposalId,
      status: review.status,
      reviewedAt: input.reviewedAt,
      note: review.note,
      observedMetrics: {
        ...review.observedMetrics,
        sampleSize: matchedProposal?.sampleSize ?? 0,
        currentProposedValue: matchedProposal?.proposedValue ?? null,
        matchingProposal: Boolean(matchedProposal),
        noActionReasonCount: relevantNoActionReasonsForProposal(
          proposal,
          postApprovalFilterAnalysis.noActionReasons,
          postApprovalOutcomeAnalysis.noActionReasons
        ).length,
        approvalAgeHours: reviewMetrics.approvalAgeHours,
        reviewWindowHours: reviewMetrics.reviewWindowHours,
        maxObservedWindowHours: reviewMetrics.maxObservedWindowHours,
        postApprovalCandidateScans: reviewMetrics.postApprovalCandidateScans,
        postApprovalWatchlistSnapshots: reviewMetrics.postApprovalWatchlistSnapshots,
        postApprovalOutcomes: reviewMetrics.postApprovalOutcomes
      }
    });
  }
}

function deriveOutcomeReview(input: {
  approvedProposal: ParameterProposalRecord;
  currentProposal: ParameterProposalRecord | undefined;
  noActionReasons: AnalysisNoActionReason[];
  currentValue: number | string | boolean | null | undefined;
  reviewMetrics: ReturnType<typeof buildProposalReviewMetrics>;
}) {
  const appliedConfigMatches = valuesMatch(input.currentValue, input.approvedProposal.proposedValue);

  if (!appliedConfigMatches) {
    return {
      status: 'needs_more_data' as const,
      note: 'Approved proposal has not yet been applied to the current strategy config, so the report cannot confirm it.',
      observedMetrics: {
        appliedConfigMatches
      }
    };
  }

  if (!hasMatureReviewWindow(input.reviewMetrics)) {
    return {
      status: 'needs_more_data' as const,
      note: 'Approved proposal is applied, but the post-approval evidence window is still too thin for a strong review.',
      observedMetrics: {
        appliedConfigMatches
      }
    };
  }

  if (!input.currentProposal) {
    if (input.noActionReasons.some((reason) => reason === 'insufficient_sample_size' || reason === 'data_coverage_gaps')) {
      return {
        status: 'needs_more_data' as const,
        note: 'Current report still lacks enough follow-up evidence to judge the approved change.',
        observedMetrics: {
          appliedConfigMatches
        }
      };
    }

    if (proposalLacksSupportAfterMatureWindow(input.approvedProposal, input.reviewMetrics)) {
      return {
        status: 'rejected' as const,
        note: 'Post-approval evidence matured without reproducing support for this parameter direction.',
        observedMetrics: {
          appliedConfigMatches
        }
      };
    }

    return {
      status: 'mixed' as const,
      note: 'Current report no longer emits the same proposal direction, but evidence is not strongly contradictory.',
      observedMetrics: {
        appliedConfigMatches
      }
    };
  }

  const approvedDirection = directionForProposal(input.approvedProposal);
  const currentDirection = directionForProposal(input.currentProposal);

  if (approvedDirection !== 'hold' && approvedDirection === currentDirection) {
    return {
      status: 'confirmed' as const,
      note: 'Current report still supports the same parameter direction as the approved proposal.',
      observedMetrics: {
        appliedConfigMatches
      }
    };
  }

  if (
    approvedDirection !== 'hold'
    && currentDirection !== 'hold'
    && approvedDirection !== currentDirection
  ) {
    return {
      status: 'rejected' as const,
      note: 'Current report now supports the opposite parameter direction for this path.',
      observedMetrics: {
        appliedConfigMatches
      }
    };
  }

  return {
    status: 'mixed' as const,
    note: 'Current report partially supports the approved parameter path, but not strongly enough for confirmation.',
    observedMetrics: {
      appliedConfigMatches
    }
  };
}

function directionForProposal(proposal: ParameterProposalRecord) {
  if (typeof proposal.oldValue === 'number' && typeof proposal.proposedValue === 'number') {
    if (proposal.proposedValue > proposal.oldValue) {
      return 'increase' as const;
    }

    if (proposal.proposedValue < proposal.oldValue) {
      return 'decrease' as const;
    }
  }

  return 'hold' as const;
}

function valuesMatch(left: unknown, right: unknown) {
  return left === right || (typeof left === 'undefined' && right === null);
}

function filterEvidenceSinceTimestamp(
  evidence: Awaited<ReturnType<typeof loadEvolutionEvidence>>,
  startIso: string
) {
  const cutoffMs = Date.parse(startIso);

  return {
    candidateScans: evidence.candidateScans.filter((scan) => Date.parse(scan.capturedAt) >= cutoffMs),
    watchlistSnapshots: evidence.watchlistSnapshots.filter((snapshot) => Date.parse(snapshot.observationAt) >= cutoffMs),
    outcomes: evidence.outcomes.filter((outcome) => Date.parse(outcome.recordedAt) >= cutoffMs)
  };
}

function buildProposalReviewMetrics(input: {
  proposal: ParameterProposalRecord;
  postApprovalEvidence: ReturnType<typeof filterEvidenceSinceTimestamp>;
  reviewedAt: string;
}) {
  const approvalTimeIso = input.proposal.decidedAt ?? input.proposal.updatedAt ?? input.proposal.createdAt;
  const approvalAgeHours = roundHours((Date.parse(input.reviewedAt) - Date.parse(approvalTimeIso)) / 3_600_000);
  const maxObservedWindowHours = Math.max(
    0,
    ...input.postApprovalEvidence.watchlistSnapshots.map((snapshot) => windowLabelToHours(snapshot.windowLabel))
  );
  const reviewWindowHours = Math.min(approvalAgeHours, maxObservedWindowHours);

  return {
    approvalAgeHours,
    reviewWindowHours,
    maxObservedWindowHours,
    postApprovalCandidateScans: input.postApprovalEvidence.candidateScans.length,
    postApprovalWatchlistSnapshots: input.postApprovalEvidence.watchlistSnapshots.length,
    postApprovalOutcomes: input.postApprovalEvidence.outcomes.length
  };
}

function hasMatureReviewWindow(metrics: ReturnType<typeof buildProposalReviewMetrics>) {
  if (metrics.postApprovalOutcomes > 0) {
    return true;
  }

  return metrics.postApprovalCandidateScans > 0
    && metrics.postApprovalWatchlistSnapshots > 0
    && metrics.maxObservedWindowHours >= 4;
}

function proposalLacksSupportAfterMatureWindow(
  proposal: ParameterProposalRecord,
  metrics: ReturnType<typeof buildProposalReviewMetrics>
) {
  if (!proposal.targetPath.startsWith('filters.') && !proposal.targetPath.startsWith('lpConfig.min')) {
    return false;
  }

  return metrics.postApprovalCandidateScans > 0
    && metrics.postApprovalWatchlistSnapshots > 0
    && metrics.maxObservedWindowHours >= 4;
}

function windowLabelToHours(windowLabel: string) {
  if (windowLabel.endsWith('m')) {
    return Number(windowLabel.slice(0, -1)) / 60;
  }

  if (windowLabel.endsWith('h')) {
    return Number(windowLabel.slice(0, -1));
  }

  return 0;
}

function roundHours(value: number) {
  return Math.round(value * 100) / 100;
}

function relevantNoActionReasonsForProposal(
  proposal: ParameterProposalRecord,
  filterNoActionReasons: AnalysisNoActionReason[],
  outcomeNoActionReasons: AnalysisNoActionReason[]
) {
  if (proposal.targetPath.startsWith('filters.') || proposal.targetPath.startsWith('lpConfig.min')) {
    return filterNoActionReasons;
  }

  return outcomeNoActionReasons;
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
