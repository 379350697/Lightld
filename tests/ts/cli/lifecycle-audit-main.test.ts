import { describe, expect, it } from 'vitest';

import {
  findLifecycleIssues,
  repairLedger
} from '../../../src/cli/lifecycle-audit-main';
import type { PendingSubmissionSnapshot, PositionLedgerSnapshot } from '../../../src/runtime/state-types';

describe('lifecycle audit', () => {
  it('does not flag a live submitted pending open as synthetic without chain evidence', () => {
    const pending: PendingSubmissionSnapshot = {
      strategyId: 'new-token-v1',
      idempotencyKey: 'open-pending',
      submissionId: 'submission-pending',
      confirmationStatus: 'submitted',
      finality: 'processed',
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      tokenMint: 'mint-pending',
      poolAddress: 'pool-pending',
      orderAction: 'add-lp'
    };
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: '2026-07-03T00:00:00.000Z',
      records: [{
        positionKey: 'idempotency:open-pending',
        idempotencyKey: 'open-pending',
        pendingSubmissionId: 'submission-pending',
        pendingOrderAction: 'add-lp',
        pendingConfirmationStatus: 'submitted',
        activeMint: 'mint-pending',
        activePoolAddress: 'pool-pending',
        lifecycleState: 'open_pending',
        lastAction: 'add-lp',
        lastReason: 'live-order-submitted',
        updatedAt: '2026-07-03T00:00:00.000Z'
      }]
    };

    expect(findLifecycleIssues(ledger, pending)).toEqual([]);
  });

  it('detects and repairs stale pending-open fields after the evidence grace window', () => {
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: '2026-07-03T09:43:00.000Z',
      records: [{
        positionKey: 'idempotency:stale-open',
        idempotencyKey: 'stale-open',
        pendingSubmissionId: 'stale-submission',
        pendingOrderAction: 'add-lp',
        pendingConfirmationStatus: 'submitted',
        activeMint: 'mint-stale',
        activePoolAddress: 'pool-stale',
        lifecycleState: 'open_pending',
        lastAction: 'add-lp',
        lastReason: 'live-order-submitted',
        updatedAt: '2026-07-03T09:42:00.000Z'
      }]
    };

    expect(findLifecycleIssues(ledger, null, '2026-07-03T09:48:01.000Z')).toEqual([
      expect.objectContaining({
        kind: 'stale-open-pending',
        positionKey: 'idempotency:stale-open'
      })
    ]);

    const repaired = repairLedger(ledger, null, '2026-07-03T09:48:01.000Z');

    expect(repaired.ledger.records[0]).toMatchObject({
      lifecycleState: 'reconcile_required',
      lastReason: 'open-pending-without-chain-evidence-repaired',
      missingOnChainSince: '2026-07-03T09:48:01.000Z'
    });
  });

  it('detects and repairs synthetic open records that have no chain evidence', () => {
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: '2026-07-03T00:00:00.000Z',
      records: [{
        positionKey: 'position:pool-a:mint-a',
        positionId: 'pool-a:mint-a',
        openIntentId: 'lp-open-intent:a',
        activeMint: 'mint-a',
        activePoolAddress: 'pool-a',
        lifecycleState: 'open',
        entrySol: 0.077,
        importStatus: 'archived_missing_without_exit_evidence',
        lastAction: 'add-lp',
        lastReason: 'chain-position-missing-without-exit-evidence',
        missingOnChainSince: '2026-07-02T18:59:20.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z'
      }]
    };

    expect(findLifecycleIssues(ledger, null)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'synthetic-live-without-chain',
        positionKey: 'position:pool-a:mint-a'
      }),
      expect.objectContaining({
        kind: 'open-but-archived-or-missing',
        positionKey: 'position:pool-a:mint-a'
      })
    ]));

    const repaired = repairLedger(ledger, null, '2026-07-03T01:00:00.000Z');

    expect(repaired.changed).toBe(true);
    expect(repaired.ledger.records[0]).toMatchObject({
      lifecycleState: 'reconcile_required',
      importStatus: 'archived_missing_without_exit_evidence',
      lastReason: 'synthetic-open-missing-chain-evidence',
      evidenceMissingReason: 'chain-position-missing-without-exit-evidence'
    });
    expect(findLifecycleIssues(repaired.ledger, null)).toEqual([]);
  });

  it('repairs synthetic open records as superseded when the chain-backed position is closed', () => {
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: '2026-07-03T00:00:00.000Z',
      records: [
        {
          positionKey: 'position:pool-a:mint-a',
          positionId: 'pool-a:mint-a',
          openIntentId: 'lp-open-intent:a',
          entryFillSubmissionId: 'fill-a',
          activeMint: 'mint-a',
          activePoolAddress: 'pool-a',
          lifecycleState: 'open',
          entrySol: 0.077,
          importStatus: 'archived_missing_without_exit_evidence',
          lastAction: 'add-lp',
          lastReason: 'chain-position-missing-without-exit-evidence',
          missingOnChainSince: '2026-07-02T18:59:20.000Z',
          updatedAt: '2026-07-03T00:00:00.000Z'
        },
        {
          positionKey: 'chain-position:chain-a',
          positionId: 'chain-a',
          chainPositionAddress: 'chain-a',
          openIntentId: 'lp-open-intent:a',
          entryFillSubmissionId: 'fill-a',
          activeMint: 'mint-a',
          activePoolAddress: 'pool-a',
          lifecycleState: 'closed',
          lastAction: 'withdraw-lp',
          lastReason: 'position-already-closed:Position not found for pool',
          lastClosedAt: '2026-07-02T18:59:20.000Z',
          updatedAt: '2026-07-02T18:59:20.000Z'
        }
      ]
    };

    const repaired = repairLedger(ledger, null, '2026-07-03T01:00:00.000Z');

    expect(repaired.ledger.records[0]).toMatchObject({
      lifecycleState: 'closed',
      importStatus: 'superseded_closed',
      supersededByPositionKey: 'chain-position:chain-a',
      lastReason: 'superseded-by-chain-closed-position'
    });
  });
});
