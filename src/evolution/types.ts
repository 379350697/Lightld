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

export const WatchlistSnapshotRecordSchema = z.object({
  watchId: z.string(),
  trackedSince: z.string(),
  strategyId: EvolutionStrategyIdSchema,
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  poolAddress: z.string(),
  observationAt: z.string(),
  windowLabel: z.string(),
  currentValueSol: z.number().finite().nonnegative().nullable(),
  liquidityUsd: z.number().finite().nonnegative().nullable(),
  activeBinId: z.number().int().nullable(),
  lowerBinId: z.number().int().nullable(),
  upperBinId: z.number().int().nullable(),
  binCount: z.number().int().nonnegative().nullable(),
  fundedBinCount: z.number().int().nonnegative().nullable(),
  solDepletedBins: z.number().int().nonnegative().nullable(),
  unclaimedFeeSol: z.number().finite().nonnegative().nullable(),
  hasInventory: z.boolean(),
  hasLpPosition: z.boolean(),
  sourceReason: z.string()
});
export type WatchlistSnapshotRecord = z.infer<typeof WatchlistSnapshotRecordSchema>;

export const TrackedWatchTokenRecordArraySchema = z.array(TrackedWatchTokenRecordSchema);
export const WatchlistSnapshotRecordArraySchema = z.array(WatchlistSnapshotRecordSchema);
export const CandidateScanRecordArraySchema = z.array(CandidateScanRecordSchema);

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

export const ParameterProposalRecordSchema = z.object({
  proposalId: z.string(),
  proposalKind: ProposalKindSchema,
  strategyId: EvolutionStrategyIdSchema,
  status: ProposalStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ParameterProposalRecord = z.infer<typeof ParameterProposalRecordSchema>;

export const ApprovalDecisionSchema = z.object({
  proposalId: z.string(),
  action: z.enum(['approve', 'reject', 'defer']),
  note: z.string().optional(),
  decidedAt: z.string()
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
