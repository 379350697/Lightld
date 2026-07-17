import { join } from 'node:path';

import { z } from 'zod';

import {
  ExecutionRequestError,
  isDefinitelyNotSubmittedBroadcastError
} from '../execution/error-classification.ts';
import type { LiveBroadcaster, LiveBroadcastResult } from '../execution/live-broadcaster.ts';
import { LiveOrderIntentSchema } from '../execution/live-order-intent-schema.ts';
import type { SignedLiveOrderIntent } from '../execution/live-signer.ts';
import type { SpendingLimitsStore } from '../risk/spending-limits.ts';
import { isSolanaTransactionSignature } from '../shared/solana-signature.ts';
import { LIVE_ACTIONS, type LiveAction } from './action-semantics.ts';
import { deleteFileIfExists, readJsonIfExists, writeJsonAtomically } from './atomic-file.ts';
import { buildTrackedPendingSubmissionSnapshot, buildUnknownPendingSubmissionSnapshot } from './live-cycle-outcomes.ts';
import { buildPendingTimeoutAt } from './live-cycle-state.ts';
import type { PendingSubmissionStore } from './pending-submission-store.ts';
import type { PendingSubmissionSnapshot } from './state-types.ts';

const SignedLiveOrderIntentSchema = z.object({
  intent: LiveOrderIntentSchema,
  signerId: z.string().min(1),
  signedAt: z.string().min(1),
  signature: z.string().min(1)
});

export const PreparedBroadcastSnapshotSchema = z.object({
  version: z.literal(1),
  strategyId: z.string().min(1),
  signedIntent: SignedLiveOrderIntentSchema,
  action: z.enum(LIVE_ACTIONS),
  captureMode: z.enum(['live', 'mechanical-soak', 'economic-shadow']).optional(),
  openIntentId: z.string().min(1).optional(),
  positionId: z.string().min(1).optional(),
  chainPositionAddress: z.string().min(1).optional(),
  poolAddress: z.string(),
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  requestedPositionSol: z.number().finite().nonnegative(),
  spendReservationRequired: z.boolean().default(false),
  disposition: z.enum(['ready', 'not-submitted']).default('ready'),
  failureReason: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).superRefine((snapshot, context) => {
  if (snapshot.strategyId !== snapshot.signedIntent.intent.strategyId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['strategyId'],
      message: 'prepared broadcast strategy does not match signed intent'
    });
  }

  if (snapshot.poolAddress !== snapshot.signedIntent.intent.poolAddress) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['poolAddress'],
      message: 'prepared broadcast pool does not match signed intent'
    });
  }

  if (snapshot.tokenMint !== snapshot.signedIntent.intent.tokenMint) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tokenMint'],
      message: 'prepared broadcast mint does not match signed intent'
    });
  }

  if (
    snapshot.spendReservationRequired
    && snapshot.action !== 'deploy'
    && snapshot.action !== 'add-lp'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['spendReservationRequired'],
      message: 'only open-risk prepared broadcasts may require a spending reservation'
    });
  }
});

export type PreparedBroadcastSnapshot = z.infer<typeof PreparedBroadcastSnapshotSchema>;

export class PreparedBroadcastStore {
  private readonly path: string;

  constructor(rootDir: string) {
    this.path = join(rootDir, 'prepared-broadcast.json');
  }

  async write(snapshot: PreparedBroadcastSnapshot) {
    const parsed = PreparedBroadcastSnapshotSchema.parse(snapshot);
    const existing = await this.read();
    if (
      existing
      && existing.signedIntent.intent.idempotencyKey !== parsed.signedIntent.intent.idempotencyKey
    ) {
      throw new Error(
        `prepared-broadcast-conflict:${existing.signedIntent.intent.idempotencyKey}`
      );
    }

    await writeJsonAtomically(this.path, parsed);
  }

  async read(): Promise<PreparedBroadcastSnapshot | null> {
    return readJsonIfExists(this.path, PreparedBroadcastSnapshotSchema);
  }

  async clear() {
    await deleteFileIfExists(this.path);
  }

  async markNotSubmitted(reason: string) {
    const existing = await this.read();
    if (!existing) {
      return;
    }

    await this.write({
      ...existing,
      disposition: 'not-submitted',
      failureReason: reason,
      updatedAt: new Date().toISOString()
    });
  }
}

export type PreparedBroadcastRecoveryResult = {
  status: 'clear' | 'submitted' | 'failed' | 'unknown' | 'conflict';
  blocked: boolean;
  reason: string;
  pendingSubmission: PendingSubmissionSnapshot | null;
  broadcastResult?: LiveBroadcastResult;
};

function pendingMatchesPrepared(
  pendingSubmission: PendingSubmissionSnapshot | null,
  prepared: PreparedBroadcastSnapshot
) {
  return pendingSubmission?.idempotencyKey === prepared.signedIntent.intent.idempotencyKey;
}

function trackedPendingFromBroadcast(input: {
  prepared: PreparedBroadcastSnapshot;
  broadcastResult: Extract<LiveBroadcastResult, { status: 'submitted' }>;
  updatedAt: string;
}) {
  const { prepared, broadcastResult, updatedAt } = input;
  const submittedIds = broadcastResult.submissionIds?.filter(Boolean)
    ?? (broadcastResult.submissionId ? [broadcastResult.submissionId] : []);
  const confirmationSignatures = (
    broadcastResult.confirmationSignatures
    ?? (broadcastResult.confirmationSignature ? [broadcastResult.confirmationSignature] : [])
  ).filter(isSolanaTransactionSignature);
  const batchPartial = broadcastResult.batchStatus === 'partial';
  const synchronouslyConfirmed = broadcastResult.mainExecutionStatus === 'confirmed' && !batchPartial;

  return buildTrackedPendingSubmissionSnapshot({
    strategyId: prepared.strategyId,
    captureMode: prepared.captureMode,
    idempotencyKey: prepared.signedIntent.intent.idempotencyKey,
    submissionId: broadcastResult.submissionId,
    openIntentId: broadcastResult.openIntentId ?? prepared.openIntentId,
    positionId: broadcastResult.positionId ?? prepared.positionId,
    chainPositionAddress: broadcastResult.chainPositionAddress ?? prepared.chainPositionAddress,
    submissionIds: submittedIds,
    confirmationSignature: broadcastResult.confirmationSignature,
    confirmationSignatures,
    confirmationStatus: batchPartial ? 'unknown' : synchronouslyConfirmed ? 'confirmed' : 'submitted',
    finality: synchronouslyConfirmed ? 'confirmed' : 'unknown',
    createdAt: prepared.createdAt,
    updatedAt,
    timeoutAt: buildPendingTimeoutAt(prepared.createdAt),
    poolAddress: prepared.poolAddress,
    tokenMint: prepared.tokenMint,
    tokenSymbol: prepared.tokenSymbol,
    preEntryTokenAmountRaw: prepared.signedIntent.intent.preEntryTokenAmountRaw,
    preEntryWalletSol: prepared.signedIntent.intent.preEntryWalletSol,
    preExitTokenAmountRaw: prepared.signedIntent.intent.preExitTokenAmountRaw,
    requestedPositionSol: prepared.requestedPositionSol,
    inputAmountRaw: prepared.signedIntent.intent.inputAmountRaw,
    orderAction: prepared.action,
    batchStatus: broadcastResult.batchStatus,
    residualSweepStatus: broadcastResult.residualSweepStatus,
    residualUnsoldAmountsRaw: broadcastResult.residualUnsoldAmountsRaw,
    reason: batchPartial ? 'pending-submission-partial-failure' : broadcastResult.reason
  });
}

function unknownPendingFromPrepared(
  prepared: PreparedBroadcastSnapshot,
  updatedAt: string,
  reason: string
) {
  return buildUnknownPendingSubmissionSnapshot({
    strategyId: prepared.strategyId,
    captureMode: prepared.captureMode,
    idempotencyKey: prepared.signedIntent.intent.idempotencyKey,
    openIntentId: prepared.openIntentId,
    positionId: prepared.positionId,
    chainPositionAddress: prepared.chainPositionAddress,
    createdAt: prepared.createdAt,
    updatedAt,
    timeoutAt: buildPendingTimeoutAt(prepared.createdAt),
    poolAddress: prepared.poolAddress,
    tokenMint: prepared.tokenMint,
    tokenSymbol: prepared.tokenSymbol,
    preEntryTokenAmountRaw: prepared.signedIntent.intent.preEntryTokenAmountRaw,
    preEntryWalletSol: prepared.signedIntent.intent.preEntryWalletSol,
    preExitTokenAmountRaw: prepared.signedIntent.intent.preExitTokenAmountRaw,
    requestedPositionSol: prepared.requestedPositionSol,
    inputAmountRaw: prepared.signedIntent.intent.inputAmountRaw,
    orderAction: prepared.action,
    reason
  });
}

async function clearMatchingUnknownPending(input: {
  pendingSubmissionStore: PendingSubmissionStore;
  pendingSubmission: PendingSubmissionSnapshot | null;
  prepared: PreparedBroadcastSnapshot;
}) {
  if (
    pendingMatchesPrepared(input.pendingSubmission, input.prepared)
    && !input.pendingSubmission?.submissionId
  ) {
    await input.pendingSubmissionStore.clear();
    return null;
  }

  return input.pendingSubmission;
}

/**
 * Replays the exact signed request recorded before the original network call.
 * The execution service owns the idempotency key, so replay can discover an
 * already accepted request without creating a second economic action.
 */
export async function recoverPreparedBroadcast(input: {
  preparedBroadcastStore: PreparedBroadcastStore;
  pendingSubmissionStore: PendingSubmissionStore;
  broadcaster?: LiveBroadcaster;
  spendingLimitsStore?: SpendingLimitsStore;
}): Promise<PreparedBroadcastRecoveryResult> {
  const prepared = await input.preparedBroadcastStore.read();
  let pendingSubmission = await input.pendingSubmissionStore.read();

  if (!prepared) {
    return {
      status: 'clear',
      blocked: false,
      reason: 'prepared-broadcast-clear',
      pendingSubmission
    };
  }

  if (pendingSubmission && !pendingMatchesPrepared(pendingSubmission, prepared)) {
    return {
      status: 'conflict',
      blocked: true,
      reason: 'prepared-broadcast-pending-conflict',
      pendingSubmission
    };
  }

  if (prepared.disposition === 'not-submitted') {
    if (prepared.spendReservationRequired && !input.spendingLimitsStore) {
      return {
        status: 'conflict',
        blocked: true,
        reason: 'prepared-broadcast-spending-store-unavailable',
        pendingSubmission
      };
    }

    if (prepared.spendReservationRequired) {
      await input.spendingLimitsStore!.releaseSpend(
        prepared.signedIntent.intent.idempotencyKey,
        prepared.requestedPositionSol
      );
    }
    pendingSubmission = await clearMatchingUnknownPending({
      pendingSubmissionStore: input.pendingSubmissionStore,
      pendingSubmission,
      prepared
    });
    await input.preparedBroadcastStore.clear();
    return {
      status: 'failed',
      blocked: false,
      reason: prepared.failureReason ?? 'prepared-broadcast-not-submitted',
      pendingSubmission
    };
  }

  if (prepared.spendReservationRequired) {
    if (!input.spendingLimitsStore) {
      return {
        status: 'conflict',
        blocked: true,
        reason: 'prepared-broadcast-spending-store-unavailable',
        pendingSubmission
      };
    }

    try {
      await input.spendingLimitsStore.reserveSpend(
        prepared.signedIntent.intent.idempotencyKey,
        prepared.requestedPositionSol
      );
    } catch (error) {
      return {
        status: 'conflict',
        blocked: true,
        reason: error instanceof Error && error.message.length > 0
          ? error.message
          : 'prepared-broadcast-spending-reservation-failed',
        pendingSubmission
      };
    }
  }

  // Pending was durably upgraded before a crash but WAL cleanup did not run.
  if (pendingSubmission?.submissionId) {
    await input.preparedBroadcastStore.clear();
    return {
      status: 'clear',
      blocked: false,
      reason: 'prepared-broadcast-already-tracked',
      pendingSubmission
    };
  }

  if (!input.broadcaster) {
    const updatedAt = new Date().toISOString();
    pendingSubmission = pendingSubmission ?? unknownPendingFromPrepared(
      prepared,
      updatedAt,
      'prepared-broadcast-broadcaster-unavailable'
    );
    await input.pendingSubmissionStore.write(pendingSubmission);
    return {
      status: 'unknown',
      blocked: true,
      reason: 'prepared-broadcast-broadcaster-unavailable',
      pendingSubmission
    };
  }

  let broadcastResult: LiveBroadcastResult;
  try {
    broadcastResult = await input.broadcaster.broadcast(
      prepared.signedIntent as SignedLiveOrderIntent
    );
  } catch (error) {
    if (isDefinitelyNotSubmittedBroadcastError(error)) {
      await input.preparedBroadcastStore.markNotSubmitted(error.reason);
      if (prepared.spendReservationRequired) {
        await input.spendingLimitsStore!.releaseSpend(
          prepared.signedIntent.intent.idempotencyKey,
          prepared.requestedPositionSol
        );
      }
      pendingSubmission = await clearMatchingUnknownPending({
        pendingSubmissionStore: input.pendingSubmissionStore,
        pendingSubmission,
        prepared
      });
      await input.preparedBroadcastStore.clear();
      return {
        status: 'failed',
        blocked: false,
        reason: error.reason,
        pendingSubmission
      };
    }

    const updatedAt = new Date().toISOString();
    const reason = error instanceof ExecutionRequestError
      ? error.reason
      : 'broadcast-outcome-unknown';
    pendingSubmission = {
      ...(pendingSubmission ?? unknownPendingFromPrepared(prepared, updatedAt, reason)),
      captureMode: pendingSubmission?.captureMode ?? prepared.captureMode,
      confirmationStatus: 'unknown',
      finality: 'unknown',
      lastCheckedAt: updatedAt,
      updatedAt,
      reason
    };
    await input.pendingSubmissionStore.write(pendingSubmission);
    return {
      status: 'unknown',
      blocked: true,
      reason,
      pendingSubmission
    };
  }

  const expectedIdempotencyKey = prepared.signedIntent.intent.idempotencyKey;
  const responseIdentityFailure = broadcastResult.idempotencyKey !== expectedIdempotencyKey
    ? 'prepared-broadcast-response-idempotency-mismatch'
    : broadcastResult.status === 'submitted' && !broadcastResult.submissionId
      ? 'prepared-broadcast-response-missing-submission-id'
      : '';
  if (responseIdentityFailure) {
    const updatedAt = new Date().toISOString();
    pendingSubmission = {
      ...(pendingSubmission ?? unknownPendingFromPrepared(prepared, updatedAt, responseIdentityFailure)),
      captureMode: pendingSubmission?.captureMode ?? prepared.captureMode,
      confirmationStatus: 'unknown',
      finality: 'unknown',
      lastCheckedAt: updatedAt,
      updatedAt,
      reason: responseIdentityFailure
    };
    await input.pendingSubmissionStore.write(pendingSubmission);
    return {
      status: 'conflict',
      blocked: true,
      reason: responseIdentityFailure,
      pendingSubmission,
      broadcastResult
    };
  }

  if (broadcastResult.status === 'failed') {
    await input.preparedBroadcastStore.markNotSubmitted(broadcastResult.reason);
    if (prepared.spendReservationRequired) {
      await input.spendingLimitsStore!.releaseSpend(
        prepared.signedIntent.intent.idempotencyKey,
        prepared.requestedPositionSol
      );
    }
    pendingSubmission = await clearMatchingUnknownPending({
      pendingSubmissionStore: input.pendingSubmissionStore,
      pendingSubmission,
      prepared
    });
    await input.preparedBroadcastStore.clear();
    return {
      status: 'failed',
      blocked: false,
      reason: broadcastResult.reason,
      pendingSubmission,
      broadcastResult
    };
  }

  pendingSubmission = trackedPendingFromBroadcast({
    prepared,
    broadcastResult,
    updatedAt: new Date().toISOString()
  });
  // Upgrade pending first. A crash between these two writes leaves both files,
  // which the next recovery recognizes as already tracked.
  await input.pendingSubmissionStore.write(pendingSubmission);
  await input.preparedBroadcastStore.clear();

  return {
    status: 'submitted',
    blocked: false,
    reason: 'prepared-broadcast-submitted',
    pendingSubmission,
    broadcastResult
  };
}

export function buildPreparedBroadcastSnapshot(input: {
  strategyId: string;
  signedIntent: SignedLiveOrderIntent;
  action: LiveAction;
  captureMode?: 'live' | 'mechanical-soak' | 'economic-shadow';
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  requestedPositionSol: number;
  spendReservationRequired?: boolean;
  createdAt: string;
}): PreparedBroadcastSnapshot {
  return PreparedBroadcastSnapshotSchema.parse({
    version: 1,
    ...input,
    updatedAt: new Date().toISOString()
  });
}
