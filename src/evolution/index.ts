export { resolveEvolutionPaths, type EvolutionPaths } from './paths.ts';
export { CandidateSampleStore } from './candidate-sample-store.ts';
export { WatchlistStore } from './watchlist-store.ts';
export { loadEvolutionEvidence, type EvolutionEvidence } from './evidence-loader.ts';
export {
  analyzeFilterEvidence,
  type FilterAnalysisResult,
  type FilterAnalysisSummary
} from './filter-analysis.ts';
export {
  analyzeOutcomeEvidence,
  type OutcomeAnalysisResult,
  type OutcomeAnalysisSummary
} from './outcome-analysis.ts';
export {
  generateEvolutionProposals,
  type GenerateEvolutionProposalsInput,
  type ProposalGenerationResult
} from './proposal-engine.ts';
export {
  generatePatchDraft,
  type PatchDraftResult
} from './patch-draft.ts';
export { ApprovalStore } from './approval-store.ts';
export type {
  AnalysisConfidence,
  AnalysisDirection,
  AnalysisNoActionReason,
  ApprovalDecision,
  CandidateRejectionStage,
  CandidateScanRecord,
  CandidateSampleRecord,
  EvolutionWatchlistCandidate,
  EvolutionStrategyId,
  LiveCycleExitMetrics,
  LiveCycleOutcomeRecord,
  LiveCycleParameterSnapshot,
  ParameterFinding,
  ParameterProposalRecord,
  ProposalKind,
  ProposalStatus,
  SessionPhase,
  TrackedWatchTokenRecord,
  WatchlistSnapshotRecord
} from './types.ts';
export {
  AnalysisConfidenceSchema,
  AnalysisDirectionSchema,
  AnalysisNoActionReasonSchema,
  ApprovalDecisionSchema,
  CandidateRejectionStageSchema,
  CandidateScanRecordArraySchema,
  CandidateScanRecordSchema,
  CandidateSampleRecordSchema,
  EvolutionWatchlistCandidateSchema,
  EvolutionStrategyIdSchema,
  LiveCycleExitMetricsSchema,
  LiveCycleOutcomeRecordSchema,
  LiveCycleOutcomeRecordArraySchema,
  LiveCycleParameterSnapshotSchema,
  ParameterFindingSchema,
  ParameterProposalRecordArraySchema,
  ParameterProposalRecordSchema,
  ProposalKindSchema,
  ProposalStatusSchema,
  SessionPhaseSchema,
  TrackedWatchTokenRecordArraySchema,
  TrackedWatchTokenRecordSchema,
  WatchlistSnapshotRecordArraySchema,
  WatchlistSnapshotRecordSchema
} from './types.ts';
