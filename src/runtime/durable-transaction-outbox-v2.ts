import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { z } from 'zod';

import { stableStringify } from '../shared/canonical-json.ts';
import { readJsonIfExists, writeJsonAtomically } from './atomic-file.ts';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const DurableOutboxStatusV2Schema = z.enum([
  'reserved',
  'signed',
  'sent',
  'visible',
  'confirmed',
  'finalized',
  'failed_terminal',
  'reconcile_required'
]);

export const OutboxTransitionV2Schema = z.object({
  transitionId: z.string().min(1),
  kind: z.enum([
    'reserved',
    'signed',
    'send_attempt',
    'visible',
    'confirmed',
    'finalized',
    'failed_terminal',
    'rollback'
  ]),
  at: z.string().datetime({ offset: true }),
  signature: z.string().min(1).optional(),
  slot: z.number().int().nonnegative().optional(),
  endpoint: z.string().min(1).optional(),
  rpcAccepted: z.boolean().optional(),
  rpcResponse: z.string().optional(),
  reason: z.string().min(1).optional()
});

export const OutboxSendAttemptV2Schema = z.object({
  attemptId: z.string().min(1),
  signature: z.string().min(1),
  endpoint: z.string().min(1),
  attemptedAt: z.string().datetime({ offset: true }),
  rpcAccepted: z.boolean(),
  rpcResponse: z.string().optional()
});

export const OutboxTransactionStatusV2Schema = z.enum([
  'built',
  'signed',
  'send_pending',
  'sent',
  'visible',
  'confirmed',
  'finalized',
  'failed_terminal',
  'reconcile_required'
]);

export const OutboxTransactionV2Schema = z.object({
  txIndex: z.number().int().nonnegative(),
  role: z.enum(['main', 'residual', 'cleanup']).default('main'),
  buildId: z.string().min(1).optional(),
  builtAt: z.string().datetime({ offset: true }).optional(),
  signature: z.string().min(1).optional(),
  signedTransactionBase64: z.string().min(1).optional(),
  signedAt: z.string().datetime({ offset: true }).optional(),
  status: OutboxTransactionStatusV2Schema,
  visibleAt: z.string().datetime({ offset: true }).optional(),
  confirmedAt: z.string().datetime({ offset: true }).optional(),
  finalizedAt: z.string().datetime({ offset: true }).optional(),
  confirmedSlot: z.number().int().nonnegative().optional(),
  finalizedSlot: z.number().int().nonnegative().optional(),
  sendAttempts: z.array(z.object({
    attemptId: z.string().min(1),
    endpoint: z.string().min(1),
    attemptedAt: z.string().datetime({ offset: true }),
    outcome: z.enum(['started', 'accepted', 'rejected', 'unknown']),
    rpcResponse: z.string().optional()
  }))
});

export const DurableOutboxRecordV2Schema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().min(1),
  lifecycleKey: z.string().min(1),
  idempotencyKey: z.string().min(1),
  intentId: z.string().min(1),
  intentSha256: Sha256Schema,
  status: DurableOutboxStatusV2Schema,
  reservedAt: z.string().datetime({ offset: true }),
  signature: z.string().min(1).optional(),
  signedTransactionBase64: z.string().min(1).optional(),
  signedAt: z.string().datetime({ offset: true }).optional(),
  visibleAt: z.string().datetime({ offset: true }).optional(),
  confirmedAt: z.string().datetime({ offset: true }).optional(),
  finalizedAt: z.string().datetime({ offset: true }).optional(),
  confirmedSlot: z.number().int().nonnegative().optional(),
  finalizedSlot: z.number().int().nonnegative().optional(),
  terminalFailureReason: z.string().min(1).optional(),
  reconcileReason: z.string().min(1).optional(),
  sendAttempts: OutboxSendAttemptV2Schema.array(),
  transactions: OutboxTransactionV2Schema.array().default([]),
  transitions: OutboxTransitionV2Schema.array().min(1)
});

export type DurableOutboxRecordV2 = z.infer<typeof DurableOutboxRecordV2Schema>;

const ReservationSchema = DurableOutboxRecordV2Schema.pick({
  runId: true,
  lifecycleKey: true,
  idempotencyKey: true,
  intentId: true,
  intentSha256: true,
  reservedAt: true
});

const SignedInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  txIndex: z.number().int().nonnegative().default(0),
  role: z.enum(['main', 'residual', 'cleanup']).default('main'),
  signature: z.string().min(1),
  signedTransactionBase64: z.string().min(1),
  signedAt: z.string().datetime({ offset: true })
});

const SendAttemptInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  txIndex: z.number().int().nonnegative().default(0),
  signature: z.string().min(1),
  endpoint: z.string().min(1),
  attemptedAt: z.string().datetime({ offset: true }),
  rpcAccepted: z.boolean(),
  rpcResponse: z.string().optional()
});

const VisibilityInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  txIndex: z.number().int().nonnegative().default(0),
  signature: z.string().min(1),
  slot: z.number().int().nonnegative().optional(),
  visibleAt: z.string().datetime({ offset: true })
});

const ConfirmationInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  txIndex: z.number().int().nonnegative().default(0),
  signature: z.string().min(1),
  slot: z.number().int().nonnegative(),
  confirmedAt: z.string().datetime({ offset: true })
});

const FinalityInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  txIndex: z.number().int().nonnegative().default(0),
  signature: z.string().min(1),
  slot: z.number().int().nonnegative(),
  finalizedAt: z.string().datetime({ offset: true })
});

const FailureInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  failedAt: z.string().datetime({ offset: true }),
  reason: z.string().min(1),
  chainAbsenceVerified: z.literal(true)
});

const RollbackInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  signature: z.string().min(1),
  detectedAt: z.string().datetime({ offset: true }),
  reason: z.string().min(1)
});

const BuiltInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  buildId: z.string().min(1),
  transactionCount: z.number().int().positive(),
  role: z.enum(['main', 'residual', 'cleanup']).default('main'),
  builtAt: z.string().datetime({ offset: true })
});

const BeginSendAttemptInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  txIndex: z.number().int().nonnegative(),
  endpoint: z.string().min(1),
  attemptedAt: z.string().datetime({ offset: true })
});

function sha256(input: string) {
  return createHash('sha256').update(input).digest('hex');
}

function transitionId(kind: string, idempotencyKey: string, at: string, suffix = '') {
  return `outbox-v2:${sha256(`${kind}\u0000${idempotencyKey}\u0000${at}\u0000${suffix}`)}`;
}

function assertSignature(record: DurableOutboxRecordV2, signature: string) {
  const hasTransactionSignature = record.transactions.some((transaction) => transaction.signature === signature);
  if (hasTransactionSignature) {
    return;
  }
  if (!record.signature) {
    throw new Error(`outbox record is not signed idempotencyKey=${record.idempotencyKey}`);
  }
  if (record.signature !== signature) {
    throw new Error(
      `outbox signature conflict idempotencyKey=${record.idempotencyKey} expected=${record.signature} observed=${signature}`
    );
  }
}

function isTerminal(record: DurableOutboxRecordV2) {
  return record.status === 'finalized' || record.status === 'failed_terminal';
}

function transactionFor(record: DurableOutboxRecordV2, txIndex: number) {
  const transaction = record.transactions.find((entry) => entry.txIndex === txIndex);
  if (!transaction) {
    throw new Error(`outbox transaction not found idempotencyKey=${record.idempotencyKey} txIndex=${txIndex}`);
  }
  return transaction;
}

function ensureTransaction(record: DurableOutboxRecordV2, txIndex: number, role: 'main' | 'residual' | 'cleanup') {
  const existing = record.transactions.find((entry) => entry.txIndex === txIndex);
  if (existing) {
    if (existing.role !== role) {
      throw new Error(`outbox transaction role conflict idempotencyKey=${record.idempotencyKey} txIndex=${txIndex}`);
    }
    return existing;
  }
  const transaction = OutboxTransactionV2Schema.parse({
    txIndex,
    role,
    status: 'built',
    sendAttempts: []
  });
  record.transactions.push(transaction);
  record.transactions.sort((left, right) => left.txIndex - right.txIndex);
  return transaction;
}

function refreshRecordStatus(record: DurableOutboxRecordV2) {
  if (record.transactions.length === 0) return;
  if (record.transactions.some((entry) => entry.status === 'reconcile_required')) {
    record.status = 'reconcile_required';
    return;
  }
  if (record.transactions.every((entry) => entry.status === 'finalized')) {
    record.status = 'finalized';
    return;
  }
  if (record.transactions.some((entry) => entry.status === 'confirmed')) {
    record.status = 'confirmed';
    return;
  }
  if (record.transactions.some((entry) => entry.status === 'visible')) {
    record.status = 'visible';
    return;
  }
  if (record.transactions.some((entry) => entry.status === 'sent' || entry.status === 'send_pending')) {
    record.status = 'sent';
    return;
  }
  if (record.transactions.some((entry) => entry.status === 'signed')) {
    record.status = 'signed';
  }
}

export class DurableTransactionOutboxV2 {
  readonly path: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(stateRootDir: string) {
    this.path = join(stateRootDir, 'transaction-outbox-v2.json');
  }

  async read(): Promise<DurableOutboxRecordV2[]> {
    return (await readJsonIfExists(this.path, DurableOutboxRecordV2Schema.array())) ?? [];
  }

  async reserve(input: z.input<typeof ReservationSchema>): Promise<DurableOutboxRecordV2> {
    const reservation = ReservationSchema.parse(input);
    return this.mutate(async (rows) => {
      const existing = rows.find((row) => row.idempotencyKey === reservation.idempotencyKey);
      if (existing) {
        const existingIdentity = {
          runId: existing.runId,
          lifecycleKey: existing.lifecycleKey,
          intentId: existing.intentId,
          intentSha256: existing.intentSha256
        };
        const requestedIdentity = {
          runId: reservation.runId,
          lifecycleKey: reservation.lifecycleKey,
          intentId: reservation.intentId,
          intentSha256: reservation.intentSha256
        };
        if (stableStringify(existingIdentity) !== stableStringify(requestedIdentity)) {
          throw new Error(`outbox idempotency conflict idempotencyKey=${reservation.idempotencyKey}`);
        }
        return existing;
      }

      const record = DurableOutboxRecordV2Schema.parse({
        schemaVersion: 2,
        ...reservation,
        status: 'reserved',
        sendAttempts: [],
        transitions: [{
          transitionId: transitionId('reserved', reservation.idempotencyKey, reservation.reservedAt),
          kind: 'reserved',
          at: reservation.reservedAt
        }]
      });
      rows.push(record);
      return record;
    });
  }

  async recordBuilt(input: z.input<typeof BuiltInputSchema>): Promise<DurableOutboxRecordV2> {
    const built = BuiltInputSchema.parse(input);
    return this.updateRequired(built.idempotencyKey, (record) => {
      if (isTerminal(record)) {
        throw new Error(`cannot build terminal outbox record idempotencyKey=${record.idempotencyKey}`);
      }
      for (let txIndex = 0; txIndex < built.transactionCount; txIndex += 1) {
        const transaction = ensureTransaction(record, txIndex, built.role);
        if (transaction.buildId && transaction.buildId !== built.buildId) {
          throw new Error(`outbox build conflict idempotencyKey=${record.idempotencyKey} txIndex=${txIndex}`);
        }
        transaction.buildId = built.buildId;
        transaction.builtAt = built.builtAt;
      }
      return record;
    });
  }

  async recordSigned(input: z.input<typeof SignedInputSchema>): Promise<DurableOutboxRecordV2> {
    const signed = SignedInputSchema.parse(input);
    return this.updateRequired(signed.idempotencyKey, (record) => {
      if (isTerminal(record)) {
        throw new Error(`cannot sign terminal outbox record idempotencyKey=${record.idempotencyKey}`);
      }
      const transaction = ensureTransaction(record, signed.txIndex, signed.role);
      if (transaction.signature) {
        if (transaction.signature !== signed.signature) {
          throw new Error(`outbox signature conflict idempotencyKey=${record.idempotencyKey} txIndex=${signed.txIndex}`);
        }
        if (transaction.signedTransactionBase64 !== signed.signedTransactionBase64) {
          throw new Error(`outbox signed transaction conflict idempotencyKey=${record.idempotencyKey} txIndex=${signed.txIndex}`);
        }
        return record;
      }
      transaction.signature = signed.signature;
      transaction.signedTransactionBase64 = signed.signedTransactionBase64;
      transaction.signedAt = signed.signedAt;
      transaction.status = 'signed';
      if (signed.txIndex === 0) {
        record.signature = signed.signature;
        record.signedTransactionBase64 = signed.signedTransactionBase64;
        record.signedAt = signed.signedAt;
      }
      refreshRecordStatus(record);
      if (!record.transitions.some((entry) => entry.kind === 'signed' && entry.signature === signed.signature)) {
        record.transitions.push({
          transitionId: transitionId('signed', record.idempotencyKey, signed.signedAt, signed.signature),
          kind: 'signed',
          at: signed.signedAt,
          signature: signed.signature
        });
      }
      return record;
    });
  }

  async recordSendAttempt(input: z.input<typeof SendAttemptInputSchema>): Promise<DurableOutboxRecordV2> {
    const attempt = SendAttemptInputSchema.parse(input);
    return this.updateRequired(attempt.idempotencyKey, (record) => {
      const transaction = transactionFor(record, attempt.txIndex);
      if (transaction.signature !== attempt.signature) {
        throw new Error(`outbox signature conflict idempotencyKey=${record.idempotencyKey} txIndex=${attempt.txIndex}`);
      }
      if (isTerminal(record)) {
        throw new Error(`cannot send terminal outbox record idempotencyKey=${record.idempotencyKey}`);
      }
      const attemptId = transitionId(
        'send_attempt',
        record.idempotencyKey,
        attempt.attemptedAt,
        `${attempt.signature}\u0000${attempt.endpoint}`
      );
      const nextAttempt = OutboxSendAttemptV2Schema.parse({ ...attempt, attemptId });
      const existing = record.sendAttempts.find((entry) => entry.attemptId === attemptId);
      if (existing) {
        if (stableStringify(existing) !== stableStringify(nextAttempt)) {
          throw new Error(`outbox send attempt conflict attemptId=${attemptId}`);
        }
        return record;
      }
      record.sendAttempts.push(nextAttempt);
      transaction.sendAttempts.push({
        attemptId,
        endpoint: attempt.endpoint,
        attemptedAt: attempt.attemptedAt,
        outcome: attempt.rpcAccepted ? 'accepted' : 'rejected',
        rpcResponse: attempt.rpcResponse
      });
      transaction.status = 'sent';
      refreshRecordStatus(record);
      record.transitions.push({
        transitionId: attemptId,
        kind: 'send_attempt',
        at: attempt.attemptedAt,
        signature: attempt.signature,
        endpoint: attempt.endpoint,
        rpcAccepted: attempt.rpcAccepted,
        rpcResponse: attempt.rpcResponse
      });
      return record;
    });
  }

  async beginSendAttempt(input: z.input<typeof BeginSendAttemptInputSchema>) {
    const attempt = BeginSendAttemptInputSchema.parse(input);
    const updated = await this.updateRequired(attempt.idempotencyKey, (record) => {
      const transaction = transactionFor(record, attempt.txIndex);
      if (!transaction.signature || !transaction.signedTransactionBase64) {
        throw new Error(`outbox transaction is not signed idempotencyKey=${record.idempotencyKey} txIndex=${attempt.txIndex}`);
      }
      if (isTerminal(record)) {
        throw new Error(`cannot send terminal outbox record idempotencyKey=${record.idempotencyKey}`);
      }
      const attemptId = transitionId(
        'send_started',
        record.idempotencyKey,
        attempt.attemptedAt,
        `${attempt.txIndex}\u0000${attempt.endpoint}`
      );
      const existing = transaction.sendAttempts.find((entry) => entry.attemptId === attemptId);
      if (existing) {
        return record;
      }
      const started = {
        attemptId,
        endpoint: attempt.endpoint,
        attemptedAt: attempt.attemptedAt,
        outcome: 'started' as const
      };
      transaction.sendAttempts.push(started);
      transaction.status = 'send_pending';
      refreshRecordStatus(record);
      record.transitions.push({
        transitionId: attemptId,
        kind: 'send_attempt',
        at: attempt.attemptedAt,
        signature: transaction.signature,
        endpoint: attempt.endpoint
      });
      return record;
    });
    const transaction = transactionFor(updated, attempt.txIndex);
    const started = transaction.sendAttempts.find((entry) =>
      entry.endpoint === attempt.endpoint
      && entry.attemptedAt === attempt.attemptedAt
      && entry.outcome === 'started'
    );
    if (!started) {
      throw new Error(`outbox send attempt not persisted idempotencyKey=${attempt.idempotencyKey} txIndex=${attempt.txIndex}`);
    }
    return started;
  }

  async recordVisible(input: z.input<typeof VisibilityInputSchema>): Promise<DurableOutboxRecordV2> {
    const visible = VisibilityInputSchema.parse(input);
    return this.updateRequired(visible.idempotencyKey, (record) => {
      const transaction = transactionFor(record, visible.txIndex);
      if (transaction.signature !== visible.signature) {
        throw new Error(`outbox signature conflict idempotencyKey=${record.idempotencyKey} txIndex=${visible.txIndex}`);
      }
      if (isTerminal(record)) return record;
      if (record.visibleAt === visible.visibleAt) return record;
      transaction.status = 'visible';
      transaction.visibleAt = visible.visibleAt;
      refreshRecordStatus(record);
      record.visibleAt = visible.visibleAt;
      record.transitions.push({
        transitionId: transitionId('visible', record.idempotencyKey, visible.visibleAt, visible.signature),
        kind: 'visible',
        at: visible.visibleAt,
        signature: visible.signature,
        slot: visible.slot
      });
      return record;
    });
  }

  async recordConfirmed(input: z.input<typeof ConfirmationInputSchema>): Promise<DurableOutboxRecordV2> {
    const confirmed = ConfirmationInputSchema.parse(input);
    return this.updateRequired(confirmed.idempotencyKey, (record) => {
      const transaction = transactionFor(record, confirmed.txIndex);
      if (transaction.signature !== confirmed.signature) {
        throw new Error(`outbox signature conflict idempotencyKey=${record.idempotencyKey} txIndex=${confirmed.txIndex}`);
      }
      if (record.status === 'finalized') return record;
      if (record.status === 'failed_terminal') {
        throw new Error(`confirmed transaction contradicts terminal failure idempotencyKey=${record.idempotencyKey}`);
      }
      if (record.confirmedAt === confirmed.confirmedAt && record.confirmedSlot === confirmed.slot) return record;
      transaction.status = 'confirmed';
      transaction.confirmedAt = confirmed.confirmedAt;
      transaction.confirmedSlot = confirmed.slot;
      refreshRecordStatus(record);
      record.confirmedAt = confirmed.confirmedAt;
      record.confirmedSlot = confirmed.slot;
      record.transitions.push({
        transitionId: transitionId('confirmed', record.idempotencyKey, confirmed.confirmedAt, confirmed.signature),
        kind: 'confirmed',
        at: confirmed.confirmedAt,
        signature: confirmed.signature,
        slot: confirmed.slot
      });
      return record;
    });
  }

  async recordFinalized(input: z.input<typeof FinalityInputSchema>): Promise<DurableOutboxRecordV2> {
    const finalized = FinalityInputSchema.parse(input);
    return this.updateRequired(finalized.idempotencyKey, (record) => {
      const transaction = transactionFor(record, finalized.txIndex);
      if (transaction.signature !== finalized.signature) {
        throw new Error(`outbox signature conflict idempotencyKey=${record.idempotencyKey} txIndex=${finalized.txIndex}`);
      }
      if (record.status === 'finalized') {
        if (record.finalizedSlot !== finalized.slot) {
          throw new Error(`outbox finality conflict idempotencyKey=${record.idempotencyKey}`);
        }
        return record;
      }
      if (record.status === 'failed_terminal') {
        throw new Error(`finalized transaction contradicts terminal failure idempotencyKey=${record.idempotencyKey}`);
      }
      transaction.status = 'finalized';
      transaction.finalizedAt = finalized.finalizedAt;
      transaction.finalizedSlot = finalized.slot;
      refreshRecordStatus(record);
      record.finalizedAt = finalized.finalizedAt;
      record.finalizedSlot = finalized.slot;
      record.transitions.push({
        transitionId: transitionId('finalized', record.idempotencyKey, finalized.finalizedAt, finalized.signature),
        kind: 'finalized',
        at: finalized.finalizedAt,
        signature: finalized.signature,
        slot: finalized.slot
      });
      return record;
    });
  }

  async recordTerminalFailure(input: z.input<typeof FailureInputSchema>): Promise<DurableOutboxRecordV2> {
    const failure = FailureInputSchema.parse(input);
    return this.updateRequired(failure.idempotencyKey, (record) => {
      if (record.status === 'finalized') {
        throw new Error(`cannot fail finalized outbox record idempotencyKey=${record.idempotencyKey}`);
      }
      if (record.status === 'failed_terminal') return record;
      record.status = 'failed_terminal';
      record.terminalFailureReason = failure.reason;
      record.transitions.push({
        transitionId: transitionId('failed_terminal', record.idempotencyKey, failure.failedAt),
        kind: 'failed_terminal',
        at: failure.failedAt,
        reason: failure.reason
      });
      return record;
    });
  }

  async recordRollback(input: z.input<typeof RollbackInputSchema>): Promise<DurableOutboxRecordV2> {
    const rollback = RollbackInputSchema.parse(input);
    return this.updateRequired(rollback.idempotencyKey, (record) => {
      assertSignature(record, rollback.signature);
      if (record.status === 'failed_terminal') {
        throw new Error(`cannot roll back terminal failure idempotencyKey=${record.idempotencyKey}`);
      }
      const transaction = record.transactions.find((entry) => entry.signature === rollback.signature);
      if (transaction) {
        transaction.status = 'reconcile_required';
      }
      record.status = 'reconcile_required';
      record.reconcileReason = rollback.reason;
      record.transitions.push({
        transitionId: transitionId('rollback', record.idempotencyKey, rollback.detectedAt, rollback.signature),
        kind: 'rollback',
        at: rollback.detectedAt,
        signature: rollback.signature,
        reason: rollback.reason
      });
      return record;
    });
  }

  async recoverPending(): Promise<DurableOutboxRecordV2[]> {
    return (await this.read()).filter((record) => !isTerminal(record));
  }

  async recoverPendingTransactions() {
    return (await this.read()).flatMap((record) =>
      record.transactions
        .filter((transaction) => transaction.status !== 'finalized' && transaction.status !== 'failed_terminal')
        .map((transaction) => ({
          idempotencyKey: record.idempotencyKey,
          runId: record.runId,
          lifecycleKey: record.lifecycleKey,
          transaction
        }))
    );
  }

  private async updateRequired(
    idempotencyKey: string,
    update: (record: DurableOutboxRecordV2) => DurableOutboxRecordV2
  ): Promise<DurableOutboxRecordV2> {
    return this.mutate(async (rows) => {
      const index = rows.findIndex((row) => row.idempotencyKey === idempotencyKey);
      if (index < 0) {
        throw new Error(`outbox reservation not found idempotencyKey=${idempotencyKey}`);
      }
      const copy = DurableOutboxRecordV2Schema.parse(rows[index]);
      const updated = DurableOutboxRecordV2Schema.parse(update(copy));
      rows[index] = updated;
      return updated;
    });
  }

  private async mutate<T>(operation: (rows: DurableOutboxRecordV2[]) => Promise<T> | T): Promise<T> {
    const next = this.operation.then(async () => {
      const rows = await this.read();
      const result = await operation(rows);
      await writeJsonAtomically(this.path, DurableOutboxRecordV2Schema.array().parse(rows));
      return result;
    });
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}
