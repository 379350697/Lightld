import { z } from 'zod';

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
  cycleId: z.string(),
  strategyId: EvolutionStrategyIdSchema,
  recordedAt: z.string(),
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  poolAddress: z.string(),
  captureMode: z.enum(['live', 'mechanical-soak', 'economic-shadow']).optional(),
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
