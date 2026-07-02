import { describe, expect, it } from 'vitest';

import {
  buildLifecycleProjection,
  isPositionRecordBusinessActive,
  isSubmittedPendingOpenRecord
} from '../../../src/runtime/lifecycle-projection';
import type { PendingSubmissionSnapshot, PositionLedgerSnapshot } from '../../../src/runtime/state-types';

const now = '2026-07-02T00:00:00.000Z';

function pendingOpen(overrides: Partial<PendingSubmissionSnapshot> = {}): PendingSubmissionSnapshot {
  return {
    strategyId: 'new-token-v1',
    idempotencyKey: 'open-1',
    submissionId: 'submission-1',
    confirmationStatus: 'submitted',
    finality: 'processed',
    createdAt: now,
    updatedAt: now,
    tokenMint: 'mint-1',
    poolAddress: 'pool-1',
    orderAction: 'add-lp',
    ...overrides
  };
}

describe('lifecycle projection', () => {
  it('keeps not-submitted add-lp attempts out of business-active positions', () => {
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: now,
      records: [{
        positionKey: 'position:pool-1:mint-1',
        positionId: 'pool-1:mint-1',
        activeMint: 'mint-1',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open_pending',
        lastAction: 'add-lp',
        lastReason: 'http-400',
        missingOnChainSince: now,
        updatedAt: now
      }]
    };

    const projection = buildLifecycleProjection({
      ledger,
      maxActivePositions: 5
    });

    expect(isPositionRecordBusinessActive(ledger.records[0])).toBe(false);
    expect(projection.chainActiveLpCount).toBe(0);
    expect(projection.pendingOpenCount).toBe(0);
    expect(projection.reconcileRequiredCount).toBe(1);
    expect(projection.activeLpCount).toBe(0);
    expect(projection.allowNewOpens).toBe(false);
  });

  it('counts submitted add-lp as pending capacity reservation without chain-active LP', () => {
    const pendingSubmission = pendingOpen();
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: now,
      records: [{
        positionKey: 'idempotency:open-1',
        idempotencyKey: 'open-1',
        pendingSubmissionId: 'submission-1',
        pendingOrderAction: 'add-lp',
        pendingConfirmationStatus: 'submitted',
        activeMint: 'mint-1',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open_pending',
        lastAction: 'add-lp',
        lastReason: 'live-order-submitted',
        updatedAt: now
      }]
    };

    const projection = buildLifecycleProjection({
      ledger,
      pendingSubmission,
      maxActivePositions: 5
    });

    expect(isSubmittedPendingOpenRecord(ledger.records[0], pendingSubmission)).toBe(true);
    expect(projection.chainActiveLpCount).toBe(0);
    expect(projection.pendingOpenCount).toBe(1);
    expect(projection.reconcileRequiredCount).toBe(0);
    expect(projection.allowNewOpens).toBe(true);
  });

  it('counts observed chain positions separately from pending opens', () => {
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: now,
      records: [{
        positionKey: 'chain-position:pos-1',
        positionId: 'pos-1',
        chainPositionAddress: 'pos-1',
        activeMint: 'mint-1',
        activePoolAddress: 'pool-1',
        lifecycleState: 'open',
        lastAction: 'add-lp',
        updatedAt: now
      }]
    };

    const projection = buildLifecycleProjection({
      ledger,
      maxActivePositions: 5
    });

    expect(projection.chainActiveLpCount).toBe(1);
    expect(projection.pendingOpenCount).toBe(0);
    expect(projection.activeLpCount).toBe(1);
    expect(projection.allowNewOpens).toBe(true);
  });

  it('does not let a superseded pool-mint open record block the chain-backed position', () => {
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: now,
      records: [
        {
          positionKey: 'position:pool-1:mint-1',
          openIntentId: 'open-intent-1',
          idempotencyKey: 'open-1',
          positionId: 'pool-1:mint-1',
          activeMint: 'mint-1',
          activePoolAddress: 'pool-1',
          lifecycleState: 'open',
          entryFillSubmissionId: 'sig-1',
          lastAction: 'add-lp',
          lastReason: 'chain-position-missing-without-exit-evidence',
          missingOnChainSince: now,
          updatedAt: now
        },
        {
          positionKey: 'chain-position:pos-1',
          openIntentId: 'open-intent-1',
          idempotencyKey: 'open-1',
          positionId: 'pos-1',
          chainPositionAddress: 'pos-1',
          activeMint: 'mint-1',
          activePoolAddress: 'pool-1',
          lifecycleState: 'open',
          entryFillSubmissionId: 'sig-1',
          lastAction: 'hold',
          updatedAt: now
        }
      ]
    };

    const projection = buildLifecycleProjection({
      ledger,
      maxActivePositions: 5
    });

    expect(projection.chainActiveLpCount).toBe(1);
    expect(projection.reconcileRequiredCount).toBe(0);
    expect(projection.activeLpCount).toBe(1);
    expect(projection.allowNewOpens).toBe(true);
  });

  it('does not let a synthetic open record block after its chain-backed position closed', () => {
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: now,
      records: [
        {
          positionKey: 'position:pool-1:mint-1',
          openIntentId: 'open-intent-1',
          idempotencyKey: 'open-1',
          positionId: 'pool-1:mint-1',
          activeMint: 'mint-1',
          activePoolAddress: 'pool-1',
          lifecycleState: 'open',
          entryFillSubmissionId: 'sig-1',
          lastAction: 'add-lp',
          lastReason: 'chain-position-missing-without-exit-evidence',
          missingOnChainSince: now,
          updatedAt: now
        },
        {
          positionKey: 'chain-position:pos-1',
          openIntentId: 'open-intent-1',
          idempotencyKey: 'open-1',
          positionId: 'pos-1',
          chainPositionAddress: 'pos-1',
          activeMint: 'mint-1',
          activePoolAddress: 'pool-1',
          lifecycleState: 'closed',
          entryFillSubmissionId: 'sig-1',
          lastAction: 'withdraw-lp',
          lastClosedAt: now,
          updatedAt: now
        }
      ]
    };

    const projection = buildLifecycleProjection({
      ledger,
      maxActivePositions: 5
    });

    expect(projection.chainActiveLpCount).toBe(0);
    expect(projection.reconcileRequiredCount).toBe(0);
    expect(projection.activeLpCount).toBe(0);
    expect(projection.allowNewOpens).toBe(true);
  });

  it('does not use an older closed chain record to supersede a later same-pool reopen', () => {
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: now,
      records: [
        {
          positionKey: 'chain-position:old-pos',
          openIntentId: 'old-open-intent',
          idempotencyKey: 'old-open',
          positionId: 'old-pos',
          chainPositionAddress: 'old-pos',
          activeMint: 'mint-1',
          activePoolAddress: 'pool-1',
          lifecycleState: 'closed',
          entryFillSubmissionId: 'old-sig',
          openedAt: '2026-07-01T00:00:00.000Z',
          lastAction: 'withdraw-lp',
          lastClosedAt: '2026-07-01T01:00:00.000Z',
          updatedAt: '2026-07-01T01:00:00.000Z'
        },
        {
          positionKey: 'position:pool-1:mint-1',
          openIntentId: 'new-open-intent',
          idempotencyKey: 'new-open',
          positionId: 'pool-1:mint-1',
          activeMint: 'mint-1',
          activePoolAddress: 'pool-1',
          lifecycleState: 'open',
          entryFillSubmissionId: 'new-sig',
          openedAt: '2026-07-02T00:00:00.000Z',
          lastAction: 'add-lp',
          lastReason: 'chain-position-missing-without-exit-evidence',
          missingOnChainSince: '2026-07-02T00:05:00.000Z',
          updatedAt: '2026-07-02T00:05:00.000Z'
        }
      ]
    };

    const projection = buildLifecycleProjection({
      ledger,
      maxActivePositions: 5
    });

    expect(projection.reconcileRequiredCount).toBe(1);
    expect(projection.allowNewOpens).toBe(false);
  });

  it('counts residual cleanup obligations without counting them as active LP capacity', () => {
    const ledger: PositionLedgerSnapshot = {
      version: 1,
      updatedAt: now,
      records: [{
        positionKey: 'chain-position:pos-1',
        positionId: 'pos-1',
        chainPositionAddress: 'pos-1',
        activeMint: 'mint-1',
        activePoolAddress: 'pool-1',
        lifecycleState: 'closed',
        residualCleanupStatus: 'residual_cleanup_pending',
        residualCleanupValueSol: 0.012,
        lastAction: 'withdraw-lp',
        lastClosedAt: now,
        updatedAt: now
      }]
    };

    const projection = buildLifecycleProjection({
      ledger,
      maxActivePositions: 1
    });

    expect(projection.residualCleanupRequiredCount).toBe(1);
    expect(projection.activeLpCount).toBe(0);
    expect(projection.allowNewOpens).toBe(true);
  });

  it('does not count SOL or stable LP account positions as business-active capacity', () => {
    const projection = buildLifecycleProjection({
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          {
            poolAddress: 'pool-sol',
            positionAddress: 'pos-sol',
            mint: 'So11111111111111111111111111111111111111112',
            hasLiquidity: true
          },
          {
            poolAddress: 'pool-usdc',
            positionAddress: 'pos-usdc',
            mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            hasLiquidity: true
          }
        ],
        journalLpPositions: [],
        fills: []
      },
      maxActivePositions: 1
    });

    expect(projection.chainActiveLpCount).toBe(0);
    expect(projection.activeLpCount).toBe(0);
    expect(projection.allowNewOpens).toBe(true);
  });
});
