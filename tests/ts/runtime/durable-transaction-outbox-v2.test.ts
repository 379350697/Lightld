import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableTransactionOutboxV2 } from '../../../src/runtime/durable-transaction-outbox-v2';

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    lifecycleKey: 'lifecycle-1',
    idempotencyKey: 'open:lifecycle-1',
    intentId: 'intent-1',
    intentSha256: 'a'.repeat(64),
    reservedAt: '2026-07-10T00:00:00.000Z',
    ...overrides
  };
}

describe('DurableTransactionOutboxV2', () => {
  it('reserves an idempotency key exactly once and rejects a different intent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-outbox-v2-'));
    const store = new DurableTransactionOutboxV2(root);

    const first = await store.reserve(reservation());
    const replay = await store.reserve(reservation());

    expect(replay).toEqual(first);
    await expect(store.reserve(reservation({ intentId: 'intent-2' }))).rejects.toThrow(
      /idempotency conflict/
    );
  });

  it('persists the signed transaction before send attempts and recovers pending work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-outbox-v2-recovery-'));
    const store = new DurableTransactionOutboxV2(root);
    await store.reserve(reservation());
    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-1',
      signedTransactionBase64: 'c2lnbmVkLXR4',
      signedAt: '2026-07-10T00:00:01.000Z'
    });
    await store.recordSendAttempt({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-1',
      endpoint: 'rpc-primary',
      attemptedAt: '2026-07-10T00:00:02.000Z',
      rpcAccepted: true,
      rpcResponse: 'signature-1'
    });

    const recovered = await new DurableTransactionOutboxV2(root).recoverPending();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'sent',
      signature: 'signature-1',
      signedTransactionBase64: 'c2lnbmVkLXR4'
    });
    expect(recovered[0].sendAttempts).toHaveLength(1);
  });

  it('allows retrying the same signature but never rebinding to a different signature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-outbox-v2-signature-'));
    const store = new DurableTransactionOutboxV2(root);
    await store.reserve(reservation());
    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-1',
      signedTransactionBase64: 'c2lnbmVkLXR4',
      signedAt: '2026-07-10T00:00:01.000Z'
    });

    await expect(store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-2',
      signedTransactionBase64: 'different',
      signedAt: '2026-07-10T00:00:02.000Z'
    })).rejects.toThrow(/signature conflict/);
  });

  it('keeps confirmed provisional and only removes finalized records from recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-outbox-v2-finality-'));
    const store = new DurableTransactionOutboxV2(root);
    await store.reserve(reservation());
    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-1',
      signedTransactionBase64: 'c2lnbmVkLXR4',
      signedAt: '2026-07-10T00:00:01.000Z'
    });
    await store.recordConfirmed({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-1',
      slot: 101,
      confirmedAt: '2026-07-10T00:00:03.000Z'
    });

    expect((await store.recoverPending())[0]?.status).toBe('confirmed');

    await store.recordFinalized({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-1',
      slot: 101,
      finalizedAt: '2026-07-10T00:00:04.000Z'
    });

    expect(await store.recoverPending()).toEqual([]);
  });

  it('moves a rolled-back confirmation into reconcile_required instead of erasing history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-outbox-v2-rollback-'));
    const store = new DurableTransactionOutboxV2(root);
    await store.reserve(reservation());
    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-1',
      signedTransactionBase64: 'c2lnbmVkLXR4',
      signedAt: '2026-07-10T00:00:01.000Z'
    });
    await store.recordConfirmed({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-1',
      slot: 101,
      confirmedAt: '2026-07-10T00:00:03.000Z'
    });
    const rolledBack = await store.recordRollback({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-1',
      detectedAt: '2026-07-10T00:00:04.000Z',
      reason: 'confirmed transaction disappeared before finality'
    });

    expect(rolledBack.status).toBe('reconcile_required');
    expect(rolledBack.transitions.map((entry) => entry.kind)).toEqual([
      'reserved',
      'signed',
      'confirmed',
      'rollback'
    ]);
    expect(await store.recoverPending()).toHaveLength(1);
  });

  it('models every transaction in a multi-transaction intent independently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-outbox-v2-batch-'));
    const store = new DurableTransactionOutboxV2(root);
    await store.reserve(reservation());
    await store.recordBuilt({
      idempotencyKey: 'open:lifecycle-1',
      buildId: 'meteora-open-1',
      transactionCount: 2,
      role: 'main',
      builtAt: '2026-07-10T00:00:00.500Z'
    });

    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 0,
      role: 'main',
      signature: 'signature-1',
      signedTransactionBase64: 'dHgtMA==',
      signedAt: '2026-07-10T00:00:01.000Z'
    });
    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 1,
      role: 'main',
      signature: 'signature-2',
      signedTransactionBase64: 'dHgtMQ==',
      signedAt: '2026-07-10T00:00:01.100Z'
    });
    await store.recordFinalized({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 0,
      signature: 'signature-1',
      slot: 101,
      finalizedAt: '2026-07-10T00:00:03.000Z'
    });

    let [record] = await store.read();
    expect(record.status).not.toBe('finalized');
    expect(record.transactions).toHaveLength(2);
    expect(record.transactions.map((tx) => tx.txIndex)).toEqual([0, 1]);

    await store.recordFinalized({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 1,
      signature: 'signature-2',
      slot: 102,
      finalizedAt: '2026-07-10T00:00:04.000Z'
    });
    [record] = await store.read();
    expect(record.status).toBe('finalized');
    expect(await store.recoverPending()).toEqual([]);
  });

  it('can roll back any transaction in a multi-transaction intent by signature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-outbox-v2-batch-rollback-'));
    const store = new DurableTransactionOutboxV2(root);
    await store.reserve(reservation());
    await store.recordBuilt({
      idempotencyKey: 'open:lifecycle-1',
      buildId: 'meteora-open-1',
      transactionCount: 2,
      role: 'main',
      builtAt: '2026-07-10T00:00:00.500Z'
    });
    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 0,
      role: 'main',
      signature: 'signature-1',
      signedTransactionBase64: 'dHgtMA==',
      signedAt: '2026-07-10T00:00:01.000Z'
    });
    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 1,
      role: 'main',
      signature: 'signature-2',
      signedTransactionBase64: 'dHgtMQ==',
      signedAt: '2026-07-10T00:00:01.100Z'
    });

    const rolledBack = await store.recordRollback({
      idempotencyKey: 'open:lifecycle-1',
      signature: 'signature-2',
      detectedAt: '2026-07-10T00:00:04.000Z',
      reason: 'second transaction disappeared before finality'
    });

    expect(rolledBack.status).toBe('reconcile_required');
    expect(rolledBack.transactions[0].status).toBe('signed');
    expect(rolledBack.transactions[1]).toMatchObject({
      txIndex: 1,
      signature: 'signature-2',
      status: 'reconcile_required'
    });
  });

  it('durably starts a send attempt before its RPC outcome is known', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-outbox-v2-send-boundary-'));
    const store = new DurableTransactionOutboxV2(root);
    await store.reserve(reservation());
    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 0,
      role: 'main',
      signature: 'signature-1',
      signedTransactionBase64: 'dHgtMA==',
      signedAt: '2026-07-10T00:00:01.000Z'
    });

    const started = await store.beginSendAttempt({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 0,
      endpoint: 'rpc-primary',
      attemptedAt: '2026-07-10T00:00:02.000Z'
    });

    const recovered = await new DurableTransactionOutboxV2(root).recoverPendingTransactions();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      idempotencyKey: 'open:lifecycle-1',
      transaction: {
        txIndex: 0,
        signature: 'signature-1',
        signedTransactionBase64: 'dHgtMA==',
        status: 'send_pending',
        sendAttempts: [{ attemptId: started.attemptId, outcome: 'started' }]
      }
    });
  });

  it('never replaces a persisted transaction index with different signed bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-outbox-v2-raw-conflict-'));
    const store = new DurableTransactionOutboxV2(root);
    await store.reserve(reservation());
    await store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 0,
      signature: 'signature-1',
      signedTransactionBase64: 'dHgtMA==',
      signedAt: '2026-07-10T00:00:01.000Z'
    });

    await expect(store.recordSigned({
      idempotencyKey: 'open:lifecycle-1',
      txIndex: 0,
      signature: 'signature-1',
      signedTransactionBase64: 'ZGlmZmVyZW50LXR4',
      signedAt: '2026-07-10T00:00:02.000Z'
    })).rejects.toThrow(/signed transaction conflict/);
  });
});
