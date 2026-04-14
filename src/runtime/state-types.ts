import { z } from 'zod';

import type { ConfirmationStatus } from '../execution/confirmation-tracker.ts';
import {
  MirrorMetricsSnapshotSchema,
  type MirrorMetricsSnapshot
} from '../observability/mirror-types.ts';

export const RuntimeModeSchema = z.enum([
  'healthy',
  'degraded',
  'circuit_open',
  'flatten_only',
  'paused',
  'recovering'
]);

export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const RuntimeStateSnapshotSchema = z.object({
  mode: RuntimeModeSchema,
  circuitReason: z.string(),
  cooldownUntil: z.string(),
  lastHealthyAt: z.string(),
  updatedAt: z.string()
});

export type RuntimeStateSnapshot = z.infer<typeof RuntimeStateSnapshotSchema>;

export const DependencyKeySchema = z.enum(['quote', 'signer', 'broadcaster', 'account', 'confirmation']);
export type DependencyKey = z.infer<typeof DependencyKeySchema>;

export const DependencyHealthEntrySchema = z.object({
  consecutiveFailures: z.number().int().nonnegative(),
  lastSuccessAt: z.string(),
  lastFailureAt: z.string(),
  lastFailureReason: z.string()
});

export type DependencyHealthEntry = z.infer<typeof DependencyHealthEntrySchema>;

export const DependencyHealthSnapshotSchema = z.object({
  quote: DependencyHealthEntrySchema,
  signer: DependencyHealthEntrySchema,
  broadcaster: DependencyHealthEntrySchema,
  account: DependencyHealthEntrySchema,
  confirmation: DependencyHealthEntrySchema
});

export type DependencyHealthSnapshot = z.infer<typeof DependencyHealthSnapshotSchema>;

export const PendingConfirmationStatusSchema = z.enum(['submitted', 'confirmed', 'failed', 'unknown']);
export type PendingConfirmationStatus = z.infer<typeof PendingConfirmationStatusSchema>;

export const PendingFinalitySchema = z.enum(['processed', 'confirmed', 'finalized', 'failed', 'unknown']);
export type PendingFinality = z.infer<typeof PendingFinalitySchema>;

export const PendingSubmissionSnapshotSchema = z.object({
  strategyId: z.string(),
  idempotencyKey: z.string(),
  submissionId: z.string(),
  confirmationSignature: z.string().optional(),
  confirmationStatus: PendingConfirmationStatusSchema,
  finality: PendingFinalitySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastCheckedAt: z.string().optional(),
  timeoutAt: z.string().optional(),
  tokenMint: z.string().optional(),
  tokenSymbol: z.string().optional(),
  reason: z.string().optional()
});

export type PendingSubmissionSnapshot = z.infer<typeof PendingSubmissionSnapshotSchema>;

export const PositionLifecycleStateSchema = z.enum([
  'open',
  'lp_exit_pending',
  'inventory_exit_pending',
  'inventory_exit_ready',
  'closed'
]);

export type PositionLifecycleState = z.infer<typeof PositionLifecycleStateSchema>;

export const PositionStateSnapshotSchema = z.object({
  allowNewOpens: z.boolean(),
  flattenOnly: z.boolean(),
  lastAction: z.string(),
  lifecycleState: PositionLifecycleStateSchema.optional(),
  updatedAt: z.string()
});

export type PositionStateSnapshot = z.infer<typeof PositionStateSnapshotSchema>;

export const HousekeepingSnapshotSchema = z.object({
  lastHousekeepingAt: z.string(),
  journalCleanupDeletedFiles: z.number().int().nonnegative(),
  mirrorPruneDeletedRows: z.number().int().nonnegative(),
  gmgnSafetyCacheEntries: z.number().int().nonnegative(),
  lastCleanupError: z.string()
});

export type HousekeepingSnapshot = z.infer<typeof HousekeepingSnapshotSchema>;

export const HealthReportSchema = z.object({
  mode: RuntimeModeSchema,
  allowNewOpens: z.boolean(),
  flattenOnly: z.boolean(),
  pendingSubmission: z.boolean(),
  circuitReason: z.string(),
  lastSuccessfulTickAt: z.string(),
  dependencyHealth: z.object({
    quoteFailures: z.number().int().nonnegative(),
    reconcileFailures: z.number().int().nonnegative()
  }),
  housekeeping: HousekeepingSnapshotSchema.optional(),
  mirror: MirrorMetricsSnapshotSchema.optional(),
  updatedAt: z.string()
});

export type HealthReport = z.infer<typeof HealthReportSchema>;
export type { MirrorMetricsSnapshot };

export function toPendingConfirmationStatus(
  status: ConfirmationStatus
): PendingConfirmationStatus {
  if (status === 'submitted' || status === 'confirmed' || status === 'failed' || status === 'unknown') {
    return status;
  }

  return 'unknown';
}
