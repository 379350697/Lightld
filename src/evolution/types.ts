import { z } from 'zod';

import { LifecycleAccountingClosureV2Schema } from '../runtime/ledger-event-v2.ts';

export const EvolutionStrategyIdSchema = z.enum(['new-token-v1', 'large-pool-v1']);
export type EvolutionStrategyId = z.infer<typeof EvolutionStrategyIdSchema>;

export const SessionPhaseSchema = z.enum(['active', 'flatten-only', 'closed']);
export type SessionPhase = z.infer<typeof SessionPhaseSchema>;

export const CandidateRejectionStageSchema = z.enum(['safety', 'lp_eligibility', 'selection', 'none']);
export type CandidateRejectionStage = z.infer<typeof CandidateRejectionStageSchema>;

export const CandidateSampleRecordSchema = z.object({
  sampleId: z.string(),
  capturedAt: z.string(),
  strategyId: EvolutionStrategyIdSchema,
  cycleId: z.string(),
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  poolAddress: z.string(),
  liquidityUsd: z.number().finite().nonnegative(),
  holders: z.number().int().nonnegative(),
  safetyScore: z.number().finite().nonnegative(),
  auxSignalScore: z.number().finite().nonnegative().default(0),
  dexscreenerBoostAmount: z.number().finite().nonnegative().default(0),
  dexscreenerHasProfile: z.boolean().default(false),
  jupiterOrganicScore: z.number().finite().nonnegative().default(0),
  jupiterTrendingRank: z.number().int().nonnegative().default(0),
  coingeckoTrendingRank: z.number().int().nonnegative().default(0),
  auxSignalStatus: z.string().default(''),
  volume24h: z.number().finite().nonnegative(),
  feeTvlRatio24h: z.number().finite().nonnegative(),
  binStep: z.number().int().nonnegative(),
  hasInventory: z.boolean(),
  hasLpPosition: z.boolean(),
  selected: z.boolean(),
  selectionRank: z.number().int().positive(),
  blockedReason: z.string().default(''),
  rejectionStage: CandidateRejectionStageSchema,
  runtimeMode: z.string(),
  sessionPhase: SessionPhaseSchema
});
export type CandidateSampleRecord = z.infer<typeof CandidateSampleRecordSchema>;

export const CandidateScanRecordSchema = z.object({
  scanId: z.string(),
  capturedAt: z.string(),
  strategyId: EvolutionStrategyIdSchema,
  poolCount: z.number().int().nonnegative(),
  prefilteredCount: z.number().int().nonnegative(),
  postLpCount: z.number().int().nonnegative(),
  postSafetyCount: z.number().int().nonnegative(),
  eligibleSelectionCount: z.number().int().nonnegative(),
  scanWindowOpen: z.boolean(),
  activePositionsCount: z.number().int().nonnegative(),
  selectedTokenMint: z.string().default(''),
  selectedPoolAddress: z.string().default(''),
  blockedReason: z.string().default(''),
  candidates: z.array(CandidateSampleRecordSchema)
});
export type CandidateScanRecord = z.infer<typeof CandidateScanRecordSchema>;

export const PoolDecisionSampleDecisionSchema = z.object({
  selected: z.boolean(),
  selectionRank: z.number().int().positive(),
  blockedReason: z.string().default(''),
  rejectionStage: CandidateRejectionStageSchema,
  runtimeMode: z.string(),
  sessionPhase: SessionPhaseSchema
});
export type PoolDecisionSampleDecision = z.infer<typeof PoolDecisionSampleDecisionSchema>;

export const PoolDecisionSampleFeatureSchema = z.object({
  liquidityUsd: z.number().finite().nonnegative(),
  holders: z.number().int().nonnegative(),
  safetyScore: z.number().finite().nonnegative(),
  auxSignalScore: z.number().finite().nonnegative().default(0),
  dexscreenerBoostAmount: z.number().finite().nonnegative().default(0),
  dexscreenerHasProfile: z.boolean().default(false),
  jupiterOrganicScore: z.number().finite().nonnegative().default(0),
  jupiterTrendingRank: z.number().int().nonnegative().default(0),
  coingeckoTrendingRank: z.number().int().nonnegative().default(0),
  auxSignalStatus: z.string().default(''),
  volume24h: z.number().finite().nonnegative(),
  feeTvlRatio24h: z.number().finite().nonnegative(),
  binStep: z.number().int().nonnegative(),
  hasInventory: z.boolean(),
  hasLpPosition: z.boolean()
});
export type PoolDecisionSampleFeature = z.infer<typeof PoolDecisionSampleFeatureSchema>;

export const PoolDecisionSampleFuturePathSchema = z.object({
  observationCount: z.number().int().nonnegative(),
  latestWindowLabel: z.string().nullable().default(null),
  latestValueSol: z.number().finite().nonnegative().nullable().default(null),
  maxObservedValueSol: z.number().finite().nonnegative().nullable().default(null),
  minObservedValueSol: z.number().finite().nonnegative().nullable().default(null),
  bestWindowLabel: z.string().nullable().default(null),
  bestWindowValueSol: z.number().finite().nonnegative().nullable().default(null),
  forwardValueByWindowLabel: z.record(z.string(), z.number().finite().nonnegative().nullable()).default({}),
  latestLiquidityUsd: z.number().finite().nonnegative().nullable().default(null),
  hasInventoryFollowThrough: z.boolean().nullable().default(null),
  hasLpPositionFollowThrough: z.boolean().nullable().default(null),
  outcomeCount: z.number().int().nonnegative(),
  latestOutcomeReason: z.string().nullable().default(null),
  latestExitMetricValue: z.number().finite().nullable().default(null)
});
export type PoolDecisionSampleFuturePath = z.infer<typeof PoolDecisionSampleFuturePathSchema>;

export const PoolDecisionSampleCounterfactualSchema = z.object({
  selectedBaselineValueSol: z.number().finite().nonnegative().nullable().default(null),
  selectedBaselineValueByWindowLabel: z.record(z.string(), z.number().finite().nonnegative().nullable()).default({}),
  relativeToSelectedBaselineSol: z.number().finite().nullable().default(null),
  relativeToSelectedBaselineByWindowLabel: z.record(z.string(), z.number().finite().nullable()).default({}),
  bestRelativeWindowLabel: z.string().nullable().default(null),
  bestRelativeWindowValueSol: z.number().finite().nullable().default(null),
  outperformedSelectedBaseline: z.boolean().nullable().default(null)
});
export type PoolDecisionSampleCounterfactual = z.infer<typeof PoolDecisionSampleCounterfactualSchema>;

export const PoolDecisionSampleRecordSchema = z.object({
  sampleId: z.string(),
  strategyId: EvolutionStrategyIdSchema,
  cycleId: z.string(),
  capturedAt: z.string(),
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  poolAddress: z.string(),
  decision: PoolDecisionSampleDecisionSchema,
  candidateFeatures: PoolDecisionSampleFeatureSchema,
  futurePath: PoolDecisionSampleFuturePathSchema,
  counterfactual: PoolDecisionSampleCounterfactualSchema
});
export type PoolDecisionSampleRecord = z.infer<typeof PoolDecisionSampleRecordSchema>;
export const PoolDecisionSampleRecordArraySchema = z.array(PoolDecisionSampleRecordSchema);

export type CounterfactualPathSummary = {
  targetPath: string;
  blockedReason: string;
  sampleCount: number;
  outperformCount: number;
  outperformRate: number;
  averageRelativeToSelectedBaselineSol: number;
  averageBestWindowValueSol: number | null;
  windowSummaries: CounterfactualWindowSummary[];
  sliceSummaries: CounterfactualSliceSummary[];
};

export type CounterfactualSliceSummary = {
  sliceLabel: string;
  sampleCount: number;
  outperformCount: number;
  outperformRate: number;
  averageRelativeToSelectedBaselineSol: number;
};

export type CounterfactualWindowSummary = {
  windowLabel: string;
  sampleCount: number;
  outperformCount: number;
  outperformRate: number;
  averageRelativeToSelectedBaselineSol: number;
};

export type CounterfactualAnalysisSummary = {
  totalSamples: number;
  eligibleCounterfactualSamples: number;
  positiveRelativeSamples: number;
};

export type CounterfactualAnalysisResult = {
  summary: CounterfactualAnalysisSummary;
  pathSummaries: CounterfactualPathSummary[];
  noActionReasons: AnalysisNoActionReason[];
};

export const TrackedWatchTokenRecordSchema = z.object({
  watchId: z.string(),
  trackedSince: z.string(),
  strategyId: EvolutionStrategyIdSchema,
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  poolAddress: z.string(),
  sourceReason: z.string(),
  firstCapturedAt: z.string(),
  lastEvaluatedAt: z.string()
});
export type TrackedWatchTokenRecord = z.infer<typeof TrackedWatchTokenRecordSchema>;

export const EvolutionWatchlistCandidateSchema = z.object({
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  poolAddress: z.string(),
  sourceReason: z.string(),
  trackedSince: z.string().optional()
});
export type EvolutionWatchlistCandidate = z.infer<typeof EvolutionWatchlistCandidateSchema>;

export const WatchlistSnapshotRecordSchema = z.object({
  watchId: z.string(),
  trackedSince: z.string(),
  strategyId: EvolutionStrategyIdSchema,
  tokenMint: z.string(),
  tokenSymbol: z.string().default(''),
  poolAddress: z.string().default(''),
  observationAt: z.string(),
  windowLabel: z.string(),
  currentValueSol: z.number().finite().nonnegative().nullable().default(null),
  liquidityUsd: z.number().finite().nonnegative().nullable().default(null),
  activeBinId: z.number().int().nullable().default(null),
  lowerBinId: z.number().int().nullable().default(null),
  upperBinId: z.number().int().nullable().default(null),
  binCount: z.number().int().nonnegative().nullable().default(null),
  fundedBinCount: z.number().int().nonnegative().nullable().default(null),
  solDepletedBins: z.number().int().nonnegative().nullable().default(null),
  unclaimedFeeSol: z.number().finite().nonnegative().nullable().default(null),
  hasInventory: z.boolean(),
  hasLpPosition: z.boolean(),
  sourceReason: z.string()
});
export type WatchlistSnapshotRecord = z.infer<typeof WatchlistSnapshotRecordSchema>;

export const TrackedWatchTokenRecordArraySchema = z.array(TrackedWatchTokenRecordSchema);
export const WatchlistSnapshotRecordArraySchema = z.array(WatchlistSnapshotRecordSchema);
export const CandidateScanRecordArraySchema = z.array(CandidateScanRecordSchema);

export const LiveCycleParameterSnapshotSchema = z.object({
  takeProfitPct: z.number().finite().positive().optional(),
  stopLossPct: z.number().finite().positive().optional(),
  lpEnabled: z.boolean(),
  lpStopLossNetPnlPct: z.number().finite().positive().optional(),
  lpTakeProfitNetPnlPct: z.number().finite().positive().optional(),
  lpSolDepletionExitBins: z.number().int().nonnegative().optional(),
  lpMinBinStep: z.number().int().positive().optional(),
  lpMinVolume24hUsd: z.number().finite().nonnegative().optional(),
  lpMinFeeTvlRatio24h: z.number().finite().nonnegative().optional(),
  maxHoldHours: z.number().finite().positive()
});
export type LiveCycleParameterSnapshot = z.infer<typeof LiveCycleParameterSnapshotSchema>;

export const LiveCycleExitMetricsSchema = z.object({
  requestedPositionSol: z.number().finite().nonnegative(),
  quoteOutputSol: z.number().finite().nonnegative().optional(),
  holdTimeMs: z.number().finite().nonnegative().optional(),
  lpNetPnlPct: z.number().finite().optional(),
  lpSolDepletedBins: z.number().int().nonnegative().optional(),
  lpCurrentValueSol: z.number().finite().nonnegative().optional(),
  lpLiquidityValueSol: z.number().finite().nonnegative().optional(),
  lpTotalValueSol: z.number().finite().nonnegative().optional(),
  lpUnclaimedFeeSol: z.number().finite().nonnegative().optional(),
  lpUnclaimedFeeValueSol: z.number().finite().nonnegative().optional(),
  lpClaimedFeeValueSol: z.number().finite().nonnegative().optional(),
  lpRecoverableRentSol: z.number().finite().nonnegative().optional(),
  lpTradingValueSol: z.number().finite().nonnegative().optional(),
  lpEntryTradingSol: z.number().finite().nonnegative().optional(),
  valuationCompleteness: z.enum(['complete', 'incomplete', 'untrusted']).optional()
});
export type LiveCycleExitMetrics = z.infer<typeof LiveCycleExitMetricsSchema>;

export const LiveCycleOutcomeRecordSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  lifecycleKey: z.string().optional(),
  runId: z.string().optional(),
  configSnapshotId: z.string().optional(),
  openIntentId: z.string().optional(),
  chainPositionAddress: z.string().optional(),
  finality: z.enum(['provisional', 'finalized']).optional(),
  exitReasons: z.array(z.string()).optional(),
  primaryReason: z.string().optional(),
  evidenceStatus: z.enum(['exact', 'partial', 'untrusted']).optional(),
  lifecycleAccountingClosure: LifecycleAccountingClosureV2Schema.optional(),
  cycleId: z.string(),
  strategyId: EvolutionStrategyIdSchema,
  recordedAt: z.string(),
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  poolAddress: z.string(),
  runtimeMode: z.string(),
  sessionPhase: SessionPhaseSchema,
  positionId: z.string().optional(),
  action: z.enum(['hold', 'deploy', 'dca-out', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']),
  actualExitReason: z.string(),
  openedAt: z.string().optional(),
  closedAt: z.string().optional(),
  entrySol: z.number().finite().nonnegative().optional(),
  maxObservedUpsidePct: z.number().finite().nonnegative().optional(),
  maxObservedDrawdownPct: z.number().finite().nonnegative().optional(),
  actualExitMetricValue: z.number().finite().optional(),
  takeProfitPctAtEntry: z.number().finite().positive().optional(),
  stopLossPctAtEntry: z.number().finite().positive().optional(),
  lpStopLossNetPnlPctAtEntry: z.number().finite().positive().optional(),
  lpTakeProfitNetPnlPctAtEntry: z.number().finite().positive().optional(),
  solDepletionExitBinsAtEntry: z.number().int().nonnegative().optional(),
  minBinStepAtEntry: z.number().int().positive().optional(),
  liveOrderSubmitted: z.boolean(),
  parameterSnapshot: LiveCycleParameterSnapshotSchema,
  exitMetrics: LiveCycleExitMetricsSchema
});
export type LiveCycleOutcomeRecord = z.infer<typeof LiveCycleOutcomeRecordSchema>;
export const LiveCycleOutcomeRecordArraySchema = z.array(LiveCycleOutcomeRecordSchema);

export const ResearchGradeLiveCycleOutcomeV2Schema = LiveCycleOutcomeRecordSchema.superRefine((value, context) => {
  const requireNonEmptyString = (field: keyof LiveCycleOutcomeRecord) => {
    const current = value[field];
    if (typeof current !== 'string' || current.trim().length === 0) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${String(field)} is required for research-grade V2 outcomes.`
      });
    }
  };

  if (value.schemaVersion !== 2) {
    context.addIssue({
      code: 'custom',
      path: ['schemaVersion'],
      message: 'Research outcomes must be schemaVersion 2.'
    });
  }

  for (const field of [
    'lifecycleKey',
    'runId',
    'configSnapshotId',
    'openIntentId',
    'chainPositionAddress',
    'positionId',
    'openedAt',
    'closedAt'
  ] as const) {
    requireNonEmptyString(field);
  }

  if (value.finality !== 'finalized') {
    context.addIssue({
      code: 'custom',
      path: ['finality'],
      message: 'Research outcomes may only be written after finalized close.'
    });
  }

  if (!Array.isArray(value.exitReasons) || value.exitReasons.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['exitReasons'],
      message: 'Research outcomes require all exit reasons.'
    });
  }

  if (value.exitReasons?.length && value.primaryReason !== value.exitReasons[0]) {
    context.addIssue({
      code: 'custom',
      path: ['primaryReason'],
      message: 'primaryReason must be the first exitReasons entry.'
    });
  }

  if (value.evidenceStatus === undefined || value.evidenceStatus === 'untrusted') {
    context.addIssue({
      code: 'custom',
      path: ['evidenceStatus'],
      message: 'Research outcomes require trusted exact or partial evidence.'
    });
  }

  if (value.lifecycleAccountingClosure?.lifecycleKey && value.lifecycleAccountingClosure.lifecycleKey !== value.lifecycleKey) {
    context.addIssue({
      code: 'custom',
      path: ['lifecycleAccountingClosure', 'lifecycleKey'],
      message: 'Accounting closure lifecycleKey must match the outcome lifecycleKey.'
    });
  }

  if (value.lifecycleAccountingClosure?.valuationConfidence === 'untrusted') {
    context.addIssue({
      code: 'custom',
      path: ['lifecycleAccountingClosure', 'valuationConfidence'],
      message: 'Research outcomes cannot reference untrusted accounting closure.'
    });
  }

  if (
    value.evidenceStatus === 'exact'
    && (
      !value.lifecycleAccountingClosure
      || !value.lifecycleAccountingClosure.formalAccountingReady
      || value.lifecycleAccountingClosure.valuationConfidence !== 'exact'
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['lifecycleAccountingClosure'],
      message: 'Exact research outcomes require an exact finalized accounting closure.'
    });
  }
});
export type ResearchGradeLiveCycleOutcomeV2 = z.infer<typeof ResearchGradeLiveCycleOutcomeV2Schema>;

export const ProposalStatusSchema = z.enum([
  'draft',
  'approved',
  'rejected',
  'deferred',
  'accepted_for_design',
  'confirmed',
  'mixed',
  'needs_more_data'
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ProposalKindSchema = z.enum(['parameter', 'system']);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

export const AnalysisDirectionSchema = z.enum(['increase', 'decrease', 'hold']);
export type AnalysisDirection = z.infer<typeof AnalysisDirectionSchema>;

export const AnalysisConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type AnalysisConfidence = z.infer<typeof AnalysisConfidenceSchema>;

export const AnalysisNoActionReasonSchema = z.enum([
  'insufficient_sample_size',
  'conflicting_evidence',
  'regime_instability',
  'data_coverage_gaps',
  'no_safe_parameter_proposal'
]);
export type AnalysisNoActionReason = z.infer<typeof AnalysisNoActionReasonSchema>;

export const ParameterFindingSchema = z.object({
  path: z.string(),
  direction: AnalysisDirectionSchema,
  sampleSize: z.number().int().nonnegative(),
  confidence: AnalysisConfidenceSchema,
  rationale: z.string(),
  supportingMetric: z.number().finite().optional()
});
export type ParameterFinding = z.infer<typeof ParameterFindingSchema>;

export const ParameterProposalRecordSchema = z.object({
  proposalId: z.string(),
  proposalKind: ProposalKindSchema,
  strategyId: EvolutionStrategyIdSchema,
  status: ProposalStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  targetPath: z.string(),
  oldValue: z.union([z.number(), z.string(), z.boolean(), z.null()]).optional(),
  proposedValue: z.union([z.number(), z.string(), z.boolean(), z.null()]).optional(),
  evidenceWindowHours: z.number().int().positive().optional(),
  sampleSize: z.number().int().nonnegative().optional(),
  analysisConfidence: AnalysisConfidenceSchema.optional(),
  supportingMetric: z.number().finite().optional(),
  coverageScore: z.number().finite().min(0).max(1).optional(),
  regimeScore: z.number().finite().min(0).max(1).optional(),
  proposalReadinessScore: z.number().finite().min(0).max(1).optional(),
  rationale: z.string().default(''),
  expectedImprovement: z.string().default(''),
  riskNote: z.string().default(''),
  uncertaintyNote: z.string().default(''),
  patchable: z.boolean().default(false),
  decisionNote: z.string().optional(),
  decidedAt: z.string().optional()
});
export type ParameterProposalRecord = z.infer<typeof ParameterProposalRecordSchema>;
export const ParameterProposalRecordArraySchema = z.array(ParameterProposalRecordSchema);

export const ApprovalDecisionSchema = z.object({
  proposalId: z.string(),
  action: z.enum(['approve', 'reject', 'defer']),
  note: z.string().optional(),
  decidedAt: z.string(),
  relatedReportPath: z.string().optional(),
  generatedPatchDraftPath: z.string().optional()
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalDecisionRecordSchema = ApprovalDecisionSchema;
export type ApprovalDecisionRecord = z.infer<typeof ApprovalDecisionRecordSchema>;
export const ApprovalDecisionRecordArraySchema = z.array(ApprovalDecisionRecordSchema);

const OutcomeReviewStatusSchema = z.enum(['confirmed', 'mixed', 'rejected', 'needs_more_data']);
export type OutcomeReviewStatus = z.infer<typeof OutcomeReviewStatusSchema>;

const OutcomeObservedMetricValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export const OutcomeReviewRecordSchema = z.object({
  proposalId: z.string(),
  status: OutcomeReviewStatusSchema,
  reviewedAt: z.string(),
  note: z.string().optional(),
  observedMetrics: z.record(z.string(), OutcomeObservedMetricValueSchema).default({})
});
export type OutcomeReviewRecord = z.infer<typeof OutcomeReviewRecordSchema>;
export const OutcomeReviewRecordArraySchema = z.array(OutcomeReviewRecordSchema);
