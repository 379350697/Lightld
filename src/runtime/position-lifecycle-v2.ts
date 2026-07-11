import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from './atomic-file.ts';

export const PositionLifecycleStatusV2Schema = z.enum([
  'open_pending',
  'open_confirmed',
  'provisional_closed',
  'finalized_closed',
  'reconcile_required',
  'failed_terminal'
]);

export const PositionLifecycleV2Schema = z.object({
  lifecycleKey: z.string().min(1),
  runId: z.string().min(1),
  strategyId: z.string().min(1),
  openIntentId: z.string().min(1),
  chainPositionAddress: z.string().min(1).optional(),
  poolAddress: z.string().min(1),
  tokenMint: z.string().min(1),
  configSnapshotId: z.string().min(1),
  parameterSnapshot: z.record(z.string(), z.unknown()).default({}),
  openSignature: z.string().min(1).optional(),
  closeSignature: z.string().min(1).optional(),
  openedAt: z.string().min(1),
  closedAt: z.string().min(1).optional(),
  openSlot: z.number().int().nonnegative().optional(),
  closeSlot: z.number().int().nonnegative().optional(),
  status: PositionLifecycleStatusV2Schema,
  exitReasons: z.array(z.string().min(1)).default([]),
  primaryReason: z.string().min(1).optional(),
  confirmedAt: z.string().min(1).optional(),
  finalizedAt: z.string().min(1).optional(),
  updatedAt: z.string().min(1)
});

export type PositionLifecycleV2 = z.infer<typeof PositionLifecycleV2Schema>;

const PositionLifecycleSnapshotV2Schema = z.object({
  version: z.literal(2),
  records: z.array(PositionLifecycleV2Schema),
  updatedAt: z.string()
});

type PositionLifecycleSnapshotV2 = z.infer<typeof PositionLifecycleSnapshotV2Schema>;

type LifecycleIdentity = Pick<
  PositionLifecycleV2,
  'lifecycleKey' | 'poolAddress' | 'tokenMint'
> & { chainPositionAddress?: string };

export function assertLifecycleIdentity(
  bound: LifecycleIdentity,
  observed: Pick<LifecycleIdentity, 'poolAddress' | 'tokenMint' | 'chainPositionAddress'>
) {
  const mismatches: string[] = [];
  if (bound.poolAddress !== observed.poolAddress) {
    mismatches.push(`poolAddress ${observed.poolAddress} != ${bound.poolAddress}`);
  }
  if (bound.tokenMint !== observed.tokenMint) {
    mismatches.push(`tokenMint ${observed.tokenMint} != ${bound.tokenMint}`);
  }
  if (
    bound.chainPositionAddress
    && observed.chainPositionAddress
    && bound.chainPositionAddress !== observed.chainPositionAddress
  ) {
    mismatches.push(
      `chainPositionAddress ${observed.chainPositionAddress} != ${bound.chainPositionAddress}`
    );
  }
  if (mismatches.length > 0) {
    throw new Error(`lifecycle identity conflict lifecycleKey=${bound.lifecycleKey}: ${mismatches.join('; ')}`);
  }
}

function emptySnapshot(): PositionLifecycleSnapshotV2 {
  return {
    version: 2,
    records: [],
    updatedAt: new Date(0).toISOString()
  };
}

export class PositionLifecycleV2Store {
  readonly path: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(stateRootDir: string) {
    this.path = join(stateRootDir, 'position-lifecycles-v2.json');
  }

  async read(): Promise<PositionLifecycleSnapshotV2> {
    return (await readJsonIfExists(this.path, PositionLifecycleSnapshotV2Schema)) ?? emptySnapshot();
  }

  async createOpen(input: {
    lifecycleKey?: string;
    runId: string;
    strategyId: string;
    openIntentId: string;
    poolAddress: string;
    tokenMint: string;
    configSnapshotId: string;
    parameterSnapshot: Record<string, unknown>;
    openedAt: string;
  }) {
    return this.mutate((snapshot) => {
      const existing = snapshot.records.find((record) => record.openIntentId === input.openIntentId);
      if (existing) {
        assertLifecycleIdentity(existing, {
          poolAddress: input.poolAddress,
          tokenMint: input.tokenMint,
          chainPositionAddress: undefined
        });
        if (
          existing.runId !== input.runId
          || existing.strategyId !== input.strategyId
          || existing.configSnapshotId !== input.configSnapshotId
          || (input.lifecycleKey !== undefined && existing.lifecycleKey !== input.lifecycleKey)
        ) {
          throw new Error(`openIntentId identity conflict openIntentId=${input.openIntentId}`);
        }
        return existing;
      }
      if (input.lifecycleKey && snapshot.records.some((record) => record.lifecycleKey === input.lifecycleKey)) {
        throw new Error(`lifecycleKey identity conflict lifecycleKey=${input.lifecycleKey}`);
      }

      const now = input.openedAt;
      const record = PositionLifecycleV2Schema.parse({
        ...input,
        lifecycleKey: input.lifecycleKey ?? `lifecycle:${randomUUID()}`,
        status: 'open_pending',
        exitReasons: [],
        updatedAt: now
      });
      snapshot.records.push(record);
      return record;
    }).catch((error) => {
      if (error instanceof Error && error.message.includes('lifecycle identity conflict')) {
        throw new Error(`openIntentId identity conflict openIntentId=${input.openIntentId}: ${error.message}`);
      }
      throw error;
    });
  }

  async bindChainPosition(lifecycleKey: string, input: {
    chainPositionAddress: string;
    openSignature: string;
    openSlot: number;
    confirmedAt: string;
  }) {
    return this.mutate((snapshot) => {
      const record = requireRecord(snapshot, lifecycleKey);
      if (record.status === 'finalized_closed' || record.status === 'failed_terminal' || record.status === 'reconcile_required') {
        throw new Error(`cannot bind chain position from lifecycle status=${record.status} lifecycleKey=${lifecycleKey}`);
      }
      const conflicting = snapshot.records.find((candidate) =>
        candidate.lifecycleKey !== lifecycleKey
        && candidate.chainPositionAddress === input.chainPositionAddress
      );
      if (conflicting) {
        throw new Error(
          `chainPositionAddress identity conflict chainPositionAddress=${input.chainPositionAddress}`
        );
      }
      if (
        record.chainPositionAddress
        && record.chainPositionAddress !== input.chainPositionAddress
      ) {
        throw new Error(
          `chainPositionAddress identity conflict lifecycleKey=${lifecycleKey}`
        );
      }

      if (record.status === 'open_confirmed') {
        if (
          record.openSignature === input.openSignature
          && record.openSlot === input.openSlot
          && record.chainPositionAddress === input.chainPositionAddress
        ) {
          return PositionLifecycleV2Schema.parse(record);
        }
        throw new Error(`open confirmation is immutable lifecycleKey=${lifecycleKey}`);
      }

      Object.assign(record, {
        chainPositionAddress: input.chainPositionAddress,
        openSignature: input.openSignature,
        openSlot: input.openSlot,
        confirmedAt: input.confirmedAt,
        status: 'open_confirmed' as const,
        updatedAt: input.confirmedAt
      });
      return PositionLifecycleV2Schema.parse(record);
    });
  }

  async finalizeClose(lifecycleKey: string, input: {
    closeSignature: string;
    closeSlot: number;
    closedAt: string;
    finalizedAt: string;
    exitReasons: string[];
  }) {
    return this.mutate((snapshot) => {
      const record = requireRecord(snapshot, lifecycleKey);
      if (record.status === 'finalized_closed') {
        if (
          record.closeSignature === input.closeSignature
          && record.closeSlot === input.closeSlot
          && record.closedAt === input.closedAt
        ) {
          return PositionLifecycleV2Schema.parse(record);
        }
        throw new Error(`finalized close is immutable lifecycleKey=${lifecycleKey}`);
      }
      if (record.status !== 'open_confirmed' && record.status !== 'provisional_closed') {
        throw new Error(`cannot finalize close from lifecycle status=${record.status} lifecycleKey=${lifecycleKey}`);
      }
      const exitReasons = [...new Set(input.exitReasons.filter(Boolean))];
      if (exitReasons.length === 0) {
        throw new Error(`finalized close requires at least one exit reason lifecycleKey=${lifecycleKey}`);
      }

      Object.assign(record, {
        closeSignature: input.closeSignature,
        closeSlot: input.closeSlot,
        closedAt: input.closedAt,
        finalizedAt: input.finalizedAt,
        exitReasons,
        primaryReason: exitReasons[0],
        status: 'finalized_closed' as const,
        updatedAt: input.finalizedAt
      });
      return PositionLifecycleV2Schema.parse(record);
    });
  }

  async markReconcileRequired(lifecycleKey: string, reason: string, observedAt: string) {
    return this.mutate((snapshot) => {
      const record = requireRecord(snapshot, lifecycleKey);
      record.status = 'reconcile_required';
      record.primaryReason = reason;
      record.exitReasons = [...new Set([...record.exitReasons, reason])];
      record.updatedAt = observedAt;
      return PositionLifecycleV2Schema.parse(record);
    });
  }

  async find(input: { lifecycleKey?: string; openIntentId?: string; chainPositionAddress?: string }) {
    const snapshot = await this.read();
    const requested = [input.lifecycleKey, input.openIntentId, input.chainPositionAddress].filter(Boolean);
    if (requested.length === 0) return undefined;
    const matches = snapshot.records.filter((record) =>
      (input.lifecycleKey === undefined || record.lifecycleKey === input.lifecycleKey)
      && (input.openIntentId === undefined || record.openIntentId === input.openIntentId)
      && (input.chainPositionAddress === undefined || record.chainPositionAddress === input.chainPositionAddress)
    );
    if (matches.length > 1) {
      throw new Error('lifecycle identity conflict: multiple records match the requested identity');
    }
    if (matches.length === 1) return matches[0];

    const partialMatches = snapshot.records.filter((record) =>
      (input.lifecycleKey !== undefined && record.lifecycleKey === input.lifecycleKey)
      || (input.openIntentId !== undefined && record.openIntentId === input.openIntentId)
      || (input.chainPositionAddress !== undefined && record.chainPositionAddress === input.chainPositionAddress)
    );
    if (partialMatches.length > 0) {
      throw new Error('lifecycle identity conflict: requested fields resolve to different records');
    }
    return undefined;
  }

  private async mutate<T>(mutator: (snapshot: PositionLifecycleSnapshotV2) => T): Promise<T> {
    const next = this.operation.then(async () => {
      const snapshot = await this.read();
      const result = mutator(snapshot);
      snapshot.updatedAt = new Date().toISOString();
      const parsed = PositionLifecycleSnapshotV2Schema.parse(snapshot);
      await writeJsonAtomically(this.path, parsed);
      return result;
    });
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}

function requireRecord(snapshot: PositionLifecycleSnapshotV2, lifecycleKey: string) {
  const record = snapshot.records.find((candidate) => candidate.lifecycleKey === lifecycleKey);
  if (!record) {
    throw new Error(`position lifecycle not found lifecycleKey=${lifecycleKey}`);
  }
  return record;
}
