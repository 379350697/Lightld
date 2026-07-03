import { describe, expect, it } from 'vitest';

import {
  applyLiveCycleResultToLedger,
  importActiveLpPositionsToLedger,
  migratePositionStateToLedger,
  selectCompatibilityPositionState,
  summarizePositionLedger
} from '../../../src/runtime/position-ledger';
import type { LiveAccountState } from '../../../src/runtime/live-account-provider';

describe('position ledger', () => {
  it('migrates legacy single position state into one ledger record', () => {
    const ledger = migratePositionStateToLedger({
      now: '2026-06-29T00:00:00.000Z',
      positionState: {
        allowNewOpens: false,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-a',
        activePoolAddress: 'pool-a',
        chainPositionAddress: 'pos-a',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        updatedAt: '2026-06-29T00:00:00.000Z'
      }
    });

    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({
      positionKey: 'chain-position:pos-a',
      activeMint: 'mint-a',
      activePoolAddress: 'pool-a',
      lifecycleState: 'open',
      entrySol: 0.1
    });
  });

  it('imports every active chain LP into independent ledger records', () => {
    const accountState: LiveAccountState = {
      walletSol: 1,
      journalSol: 1,
      walletTokens: [],
      journalTokens: [],
      walletLpPositions: [
        {
          poolAddress: 'pool-a',
          positionAddress: 'pos-a',
          mint: 'mint-a',
          hasLiquidity: true,
          currentValueSol: 0.11
        },
        {
          poolAddress: 'pool-b',
          positionAddress: 'pos-b',
          mint: 'mint-b',
          hasLiquidity: true,
          currentValueSol: 0.22
        }
      ],
      journalLpPositions: [],
      fills: [{
        submissionId: 'sub-a',
        mint: 'mint-a',
        side: 'add-lp',
        amount: 0.1,
        actualFilledSol: 0.1,
        fillAmountSource: 'wallet-delta',
        hasFillEvidence: true,
        chainPositionAddress: 'pos-a',
        recordedAt: '2026-06-29T00:00:00.000Z'
      }]
    };

    const ledger = importActiveLpPositionsToLedger({
      accountState,
      now: '2026-06-29T00:01:00.000Z'
    });

    expect(ledger.records).toHaveLength(2);
    expect(ledger.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        positionKey: 'chain-position:pos-a',
        activeMint: 'mint-a',
        entrySol: 0.1,
        importStatus: 'imported'
      }),
      expect.objectContaining({
        positionKey: 'chain-position:pos-b',
        activeMint: 'mint-b',
        importStatus: 'entry_unknown'
      })
    ]));
  });

  it('persists LP risk sentinel snapshots when importing active chain LPs', () => {
    const ledger = importActiveLpPositionsToLedger({
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-risk',
          positionAddress: 'pos-risk',
          mint: 'mint-risk',
          lowerBinId: -234,
          upperBinId: -166,
          activeBinId: -149,
          hasLiquidity: true,
          currentValueSol: 0.114030143,
          liquidityValueSol: 0.056624063
        }],
        journalLpPositions: [],
        fills: []
      },
      now: '2026-06-30T12:00:32.674Z'
    });

    expect(ledger.records[0]?.lastRiskSentinel).toMatchObject({
      riskIntent: 'range-exit',
      riskReason: 'active-bin-out-of-range:above:17',
      outOfRangeSide: 'above',
      outOfRangeBins: 17
    });
  });

  it('keeps same pool and mint LPs as independent records when chain addresses differ', () => {
    const ledger = importActiveLpPositionsToLedger({
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          {
            poolAddress: 'pool-shared',
            positionAddress: 'pos-a',
            mint: 'mint-shared',
            hasLiquidity: true,
            currentValueSol: 0.11
          },
          {
            poolAddress: 'pool-shared',
            positionAddress: 'pos-b',
            mint: 'mint-shared',
            hasLiquidity: true,
            currentValueSol: 0.22
          }
        ],
        journalLpPositions: [],
        fills: [{
          submissionId: 'sub-pool-only',
          mint: 'mint-shared',
          side: 'add-lp',
          amount: 0.9,
          actualFilledSol: 0.9,
          fillAmountSource: 'wallet-delta',
          hasFillEvidence: true,
          positionId: 'pool-shared:mint-shared',
          recordedAt: '2026-06-29T00:00:00.000Z'
        }]
      },
      now: '2026-06-29T00:01:00.000Z'
    });

    expect(ledger.records).toHaveLength(2);
    expect(ledger.records.map((record) => record.positionKey).sort()).toEqual([
      'chain-position:pos-a',
      'chain-position:pos-b'
    ]);
    expect(ledger.records.every((record) => record.entrySol === undefined)).toBe(true);
  });

  it('merges a synthetic open record into the discovered chain LP record for the same pool and mint', () => {
    const ledger = importActiveLpPositionsToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'position:pool-a:mint-a',
          positionId: 'pool-a:mint-a',
          openIntentId: 'intent-a',
          idempotencyKey: 'open-pool-a',
          activeMint: 'mint-a',
          activePoolAddress: 'pool-a',
          lifecycleState: 'open',
          entrySol: 0.1,
          entrySolSource: 'actual_fill',
          lastAction: 'add-lp',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-a',
          positionAddress: 'pos-a',
          mint: 'mint-a',
          hasLiquidity: true,
          currentValueSol: 0.11
        }],
        journalLpPositions: [],
        fills: []
      },
      now: '2026-06-29T00:02:00.000Z'
    });

    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({
      positionKey: 'chain-position:pos-a',
      positionId: 'pos-a',
      chainPositionAddress: 'pos-a',
      activePoolAddress: 'pool-a',
      activeMint: 'mint-a',
      entrySol: 0.1,
      lastAction: 'add-lp'
    });
  });

  it('does not revive failed terminal open attempts when a later chain LP appears on the same pool and mint', () => {
    const ledger = importActiveLpPositionsToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-07-02T00:00:00.000Z',
        records: [{
          positionKey: 'position:pool-a:mint-a',
          positionId: 'pool-a:mint-a',
          openIntentId: 'lp-open-intent:failed',
          idempotencyKey: 'failed-open',
          activeMint: 'mint-a',
          activePoolAddress: 'pool-a',
          lifecycleState: 'failed_terminal',
          importStatus: 'archived_missing_without_exit_evidence',
          lastAction: 'add-lp',
          lastReason: 'http-400',
          updatedAt: '2026-07-02T00:00:00.000Z'
        }]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-a',
          positionAddress: 'pos-a',
          mint: 'mint-a',
          hasLiquidity: true,
          currentValueSol: 0.11
        }],
        journalLpPositions: [],
        fills: []
      },
      now: '2026-07-02T00:02:00.000Z'
    });

    expect(ledger.records).toHaveLength(2);
    const failedRecord = ledger.records.find((record) => record.positionKey === 'position:pool-a:mint-a');
    expect(failedRecord).toMatchObject({
      lifecycleState: 'failed_terminal'
    });
    expect(failedRecord?.chainPositionAddress).toBeUndefined();
    expect(ledger.records.find((record) => record.positionKey === 'chain-position:pos-a')).toMatchObject({
      lifecycleState: 'open',
      chainPositionAddress: 'pos-a'
    });
  });

  it('does not close a ledger record only because the current account snapshot is missing it', () => {
    const ledger = importActiveLpPositionsToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-a',
          positionId: 'pos-a',
          chainPositionAddress: 'pos-a',
          activeMint: 'mint-a',
          activePoolAddress: 'pool-a',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      now: '2026-06-29T00:02:00.000Z'
    });

    expect(ledger.records[0]).toMatchObject({
      lifecycleState: 'open',
      missingOnChainSince: '2026-06-29T00:02:00.000Z'
    });
  });

  it('does not revive stale pending opens without a submitted pending submission', () => {
    const ledger = importActiveLpPositionsToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'position:pool-pending:mint-pending',
          positionId: 'pool-pending:mint-pending',
          openIntentId: 'lp-open-intent:pending',
          activeMint: 'mint-pending',
          activePoolAddress: 'pool-pending',
          lifecycleState: 'open_pending',
          lastAction: 'add-lp',
          lastReason: 'live-order-submitted',
          missingOnChainSince: '2026-06-29T00:01:00.000Z',
          updatedAt: '2026-06-29T00:01:00.000Z'
        }]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      closeMissingActive: true,
      now: '2026-06-29T00:02:00.000Z'
    });

    expect(ledger.records[0]).toMatchObject({
      lifecycleState: 'failed_terminal',
      lastReason: 'live-order-submitted',
      missingOnChainSince: '2026-06-29T00:01:00.000Z'
    });
    expect(summarizePositionLedger(ledger).activeLpCount).toBe(0);
    expect(summarizePositionLedger(ledger).reconcileRequiredCount).toBe(0);
  });

  it('closes archived synthetic opens when a matching chain-backed position is already closed', () => {
    const ledger = importActiveLpPositionsToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-07-03T08:48:49.000Z',
        records: [
          {
            positionKey: 'position:pool-a:mint-a',
            positionId: 'pool-a:mint-a',
            openIntentId: 'lp-open-intent:a',
            idempotencyKey: 'open-a',
            activeMint: 'mint-a',
            activePoolAddress: 'pool-a',
            lifecycleState: 'open',
            entrySol: 0.077,
            entrySolSource: 'actual_fill',
            entryFillSubmissionId: 'fill-a',
            openedAt: '2026-07-02T15:52:20.000Z',
            importStatus: 'archived_missing_without_exit_evidence',
            lastAction: 'add-lp',
            lastReason: 'chain-position-missing-without-exit-evidence',
            missingOnChainSince: '2026-07-02T18:59:20.000Z',
            updatedAt: '2026-07-03T08:48:49.000Z'
          },
          {
            positionKey: 'chain-position:chain-a',
            positionId: 'chain-a',
            chainPositionAddress: 'chain-a',
            openIntentId: 'lp-open-intent:a',
            idempotencyKey: 'open-a',
            activeMint: 'mint-a',
            activePoolAddress: 'pool-a',
            lifecycleState: 'closed',
            entryFillSubmissionId: 'fill-a',
            lastAction: 'withdraw-lp',
            lastReason: 'position-already-closed:Position not found for pool',
            lastClosedAt: '2026-07-02T18:59:20.000Z',
            updatedAt: '2026-07-02T18:59:20.000Z'
          }
        ]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      closeMissingActive: true,
      now: '2026-07-03T09:00:00.000Z'
    });

    expect(ledger.records.find((record) => record.positionKey === 'position:pool-a:mint-a')).toMatchObject({
      lifecycleState: 'closed',
      importStatus: 'superseded_closed',
      supersededByPositionKey: 'chain-position:chain-a',
      lastReason: 'superseded-by-chain-closed-position'
    });
    expect(summarizePositionLedger(ledger)).toMatchObject({
      activeLpCount: 0,
      reconcileRequiredCount: 0
    });
  });

  it('keeps submitted pending opens as capacity reservations while waiting for chain evidence', () => {
    const ledger = importActiveLpPositionsToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'idempotency:open-pending',
          idempotencyKey: 'open-pending',
          activeMint: 'mint-pending',
          activePoolAddress: 'pool-pending',
          pendingSubmissionId: 'submission-pending',
          pendingOrderAction: 'add-lp',
          pendingConfirmationStatus: 'submitted',
          lifecycleState: 'open_pending',
          lastAction: 'add-lp',
          lastReason: 'live-order-submitted',
          missingOnChainSince: '2026-06-29T00:01:00.000Z',
          updatedAt: '2026-06-29T00:01:00.000Z'
        }]
      },
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'open-pending',
        submissionId: 'submission-pending',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-06-29T00:01:00.000Z',
        updatedAt: '2026-06-29T00:01:00.000Z',
        tokenMint: 'mint-pending',
        poolAddress: 'pool-pending',
        orderAction: 'add-lp'
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      closeMissingActive: true,
      now: '2026-06-29T00:02:00.000Z'
    });

    expect(ledger.records[0]).toMatchObject({
      lifecycleState: 'open_pending',
      missingOnChainSince: undefined
    });
    expect(summarizePositionLedger(ledger).pendingOpenCount).toBe(1);
  });

  it('closes missing ledger records that already submitted full LP exits when requested by unified semantics', () => {
    const ledger = importActiveLpPositionsToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [
          {
            positionKey: 'chain-position:pos-exited',
            positionId: 'pos-exited',
            chainPositionAddress: 'pos-exited',
            activeMint: 'mint-exited',
            activePoolAddress: 'pool-exited',
            lifecycleState: 'open',
            lastAction: 'withdraw-lp',
            lastReason: 'live-order-submitted',
            lastOrderIdempotencyKey: 'exit-pos-exited',
            missingOnChainSince: '2026-06-29T00:02:00.000Z',
            updatedAt: '2026-06-29T00:02:00.000Z'
          },
          {
            positionKey: 'chain-position:pos-active',
            positionId: 'pos-active',
            chainPositionAddress: 'pos-active',
            activeMint: 'mint-active',
            activePoolAddress: 'pool-active',
            lifecycleState: 'open',
            lastAction: 'add-lp',
            updatedAt: '2026-06-29T00:00:00.000Z'
          },
          {
            positionKey: 'chain-position:pos-missing-without-exit',
            positionId: 'pos-missing-without-exit',
            chainPositionAddress: 'pos-missing-without-exit',
            activeMint: 'mint-missing-without-exit',
            activePoolAddress: 'pool-missing-without-exit',
            lifecycleState: 'open',
            lastAction: 'add-lp',
            updatedAt: '2026-06-29T00:00:00.000Z'
          }
        ]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-active',
          positionAddress: 'pos-active',
          mint: 'mint-active',
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      },
      closeMissingActive: true,
      now: '2026-06-29T00:03:00.000Z'
    });

    expect(ledger.records.find((record) => record.chainPositionAddress === 'pos-exited')).toMatchObject({
      lifecycleState: 'closed',
      lastAction: 'withdraw-lp',
      lastReason: 'live-order-submitted',
      lastClosedAt: '2026-06-29T00:03:00.000Z'
    });
    expect(ledger.records.find((record) => record.chainPositionAddress === 'pos-active')).toMatchObject({
      lifecycleState: 'open',
      missingOnChainSince: undefined
    });
    expect(ledger.records.find((record) => record.chainPositionAddress === 'pos-missing-without-exit')).toMatchObject({
      lifecycleState: 'open',
      importStatus: 'archived_missing_without_exit_evidence',
      lastReason: 'chain-position-missing-without-exit-evidence',
      missingOnChainSince: '2026-06-29T00:03:00.000Z'
    });
  });

  it('closes only the withdraw target ledger record after confirmed exit', () => {
    const ledger = applyLiveCycleResultToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [
          {
            positionKey: 'chain-position:pos-a',
            positionId: 'pos-a',
            chainPositionAddress: 'pos-a',
            activeMint: 'mint-a',
            activePoolAddress: 'pool-a',
            lifecycleState: 'open',
            lastAction: 'add-lp',
            updatedAt: '2026-06-29T00:00:00.000Z'
          },
          {
            positionKey: 'chain-position:pos-b',
            positionId: 'pos-b',
            chainPositionAddress: 'pos-b',
            activeMint: 'mint-b',
            activePoolAddress: 'pool-b',
            lifecycleState: 'open',
            lastAction: 'add-lp',
            updatedAt: '2026-06-29T00:00:00.000Z'
          }
        ]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-b',
          positionAddress: 'pos-b',
          mint: 'mint-b',
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      },
      actionIdentity: {
        chainPositionAddress: 'pos-a',
        positionId: 'pos-a'
      },
      orderIntent: {
        idempotencyKey: 'exit-pos-a',
        poolAddress: 'pool-a',
        tokenMint: 'mint-a'
      },
      action: 'withdraw-lp',
      reason: 'live-order-submitted',
      liveOrderSubmitted: true,
      confirmationStatus: 'confirmed',
      now: '2026-06-29T00:03:00.000Z'
    });

    expect(ledger.records.find((record) => record.chainPositionAddress === 'pos-a')).toMatchObject({
      lifecycleState: 'closed',
      lastAction: 'withdraw-lp'
    });
    expect(ledger.records.find((record) => record.chainPositionAddress === 'pos-b')).toMatchObject({
      lifecycleState: 'open',
      lastAction: 'add-lp'
    });
  });

  it('closes superseded synthetic records when the chain-backed LP closes', () => {
    const ledger = applyLiveCycleResultToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-07-02T00:00:00.000Z',
        records: [
          {
            positionKey: 'position:pool-a:mint-a',
            positionId: 'pool-a:mint-a',
            openIntentId: 'open-a',
            idempotencyKey: 'open-order-a',
            activeMint: 'mint-a',
            activePoolAddress: 'pool-a',
            lifecycleState: 'open',
            entryFillSubmissionId: 'entry-a',
            missingOnChainSince: '2026-07-02T00:02:00.000Z',
            lastAction: 'add-lp',
            lastReason: 'chain-position-missing-without-exit-evidence',
            updatedAt: '2026-07-02T00:02:00.000Z'
          },
          {
            positionKey: 'chain-position:pos-a',
            positionId: 'pos-a',
            chainPositionAddress: 'pos-a',
            openIntentId: 'open-a',
            idempotencyKey: 'open-order-a',
            activeMint: 'mint-a',
            activePoolAddress: 'pool-a',
            lifecycleState: 'open',
            entryFillSubmissionId: 'entry-a',
            lastAction: 'add-lp',
            updatedAt: '2026-07-02T00:01:00.000Z'
          }
        ]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      actionIdentity: {
        chainPositionAddress: 'pos-a',
        positionId: 'pos-a',
        openIntentId: 'open-a'
      },
      orderIntent: {
        idempotencyKey: 'exit-pos-a',
        poolAddress: 'pool-a',
        tokenMint: 'mint-a'
      },
      action: 'withdraw-lp',
      reason: 'live-order-submitted',
      liveOrderSubmitted: true,
      confirmationStatus: 'confirmed',
      now: '2026-07-02T00:03:00.000Z'
    });

    expect(ledger.records).toHaveLength(2);
    expect(ledger.records.find((record) => record.positionKey === 'chain-position:pos-a')).toMatchObject({
      lifecycleState: 'closed',
      lastAction: 'withdraw-lp'
    });
    expect(ledger.records.find((record) => record.positionKey === 'position:pool-a:mint-a')).toMatchObject({
      lifecycleState: 'closed',
      importStatus: 'superseded_closed',
      lastReason: 'superseded-by-chain-closed-position',
      lastClosedAt: '2026-07-02T00:03:00.000Z'
    });
    expect(summarizePositionLedger(ledger).reconcileRequiredCount).toBe(0);
  });

  it('records residual cleanup obligation on a closed LP without keeping it active', () => {
    const ledger = applyLiveCycleResultToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-07-02T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-a',
          positionId: 'pos-a',
          chainPositionAddress: 'pos-a',
          activeMint: 'mint-a',
          activePoolAddress: 'pool-a',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          updatedAt: '2026-07-02T00:00:00.000Z'
        }]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      actionIdentity: {
        chainPositionAddress: 'pos-a',
        positionId: 'pos-a'
      },
      orderIntent: {
        idempotencyKey: 'exit-pos-a',
        poolAddress: 'pool-a',
        tokenMint: 'mint-a'
      },
      action: 'withdraw-lp',
      reason: 'residual token sweep incomplete',
      liveOrderSubmitted: true,
      confirmationStatus: 'confirmed',
      residualCleanupStatus: 'residual_cleanup_pending',
      residualCleanupValueSol: 0.012,
      now: '2026-07-02T00:03:00.000Z'
    });

    expect(ledger.records[0]).toMatchObject({
      lifecycleState: 'closed',
      residualCleanupStatus: 'residual_cleanup_pending',
      residualCleanupValueSol: 0.012
    });
    expect(summarizePositionLedger(ledger)).toMatchObject({
      activeLpCount: 0,
      residualCleanupRequiredCount: 1
    });
  });

  it('does not create phantom open-pending records for failed add-lp attempts', () => {
    const ledger = applyLiveCycleResultToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: []
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      orderIntent: {
        idempotencyKey: 'failed-open',
        poolAddress: 'pool-failed',
        tokenMint: 'mint-failed'
      },
      action: 'add-lp',
      reason: 'http-400',
      liveOrderSubmitted: false,
      now: '2026-06-29T00:02:00.000Z'
    });

    expect(ledger.records).toHaveLength(0);
  });

  it('does not mutate LP ledger records from residual dca-out outcomes', () => {
    const ledger = applyLiveCycleResultToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-a',
          positionId: 'pos-a',
          chainPositionAddress: 'pos-a',
          activeMint: 'lp-mint',
          activePoolAddress: 'lp-pool',
          lifecycleState: 'open',
          entrySol: 0.1,
          lastAction: 'add-lp',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }]
      },
      accountState: {
        walletSol: 1,
        journalSol: 1,
        walletTokens: [{
          mint: 'residual-mint',
          amount: 10,
          currentValueSol: 0.2
        }],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'lp-pool',
          positionAddress: 'pos-a',
          mint: 'lp-mint',
          hasLiquidity: true,
          currentValueSol: 0.11
        }],
        journalLpPositions: [],
        fills: []
      },
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'lp-mint',
        activePoolAddress: 'lp-pool',
        chainPositionAddress: 'pos-a',
        lifecycleState: 'open',
        updatedAt: '2026-06-29T00:00:00.000Z'
      },
      orderIntent: {
        idempotencyKey: 'residual-sell',
        poolAddress: '',
        tokenMint: 'residual-mint'
      },
      action: 'dca-out',
      reason: 'http-400',
      liveOrderSubmitted: false,
      now: '2026-06-29T00:03:00.000Z'
    });

    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({
      positionKey: 'chain-position:pos-a',
      chainPositionAddress: 'pos-a',
      activeMint: 'lp-mint',
      activePoolAddress: 'lp-pool',
      lifecycleState: 'open',
      lastAction: 'add-lp'
    });
  });

  it('does not copy stale position-state intent onto a different chain target', () => {
    const ledger = applyLiveCycleResultToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [
          {
            positionKey: 'chain-position:pos-a',
            positionId: 'pos-a',
            chainPositionAddress: 'pos-a',
            activeMint: 'mint-a',
            activePoolAddress: 'pool-a',
            lifecycleState: 'open',
            lastAction: 'add-lp',
            updatedAt: '2026-06-29T00:00:00.000Z'
          }
        ]
      },
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-b',
        activePoolAddress: 'pool-b',
        openIntentId: 'lp-open-intent:wrong',
        positionId: 'pos-b',
        chainPositionAddress: 'pos-b',
        lifecycleState: 'open',
        updatedAt: '2026-06-29T00:00:00.000Z'
      },
      actionIdentity: {
        chainPositionAddress: 'pos-a',
        positionId: 'pos-a'
      },
      orderIntent: {
        idempotencyKey: 'exit-pos-a',
        poolAddress: 'pool-a',
        tokenMint: 'mint-a'
      },
      action: 'withdraw-lp',
      reason: 'live-order-submitted',
      liveOrderSubmitted: true,
      confirmationStatus: 'confirmed',
      now: '2026-06-29T00:03:00.000Z'
    });

    expect(ledger.records[0].openIntentId).toBeUndefined();
  });

  it('does not reopen a superseded synthetic record when the same pool is opened again', () => {
    const ledger = applyLiveCycleResultToLedger({
      ledger: {
        version: 1,
        updatedAt: '2026-07-02T15:00:00.000Z',
        records: [{
          positionKey: 'position:pool-a:mint-a',
          openIntentId: 'lp-open-intent:old',
          idempotencyKey: 'old-open',
          positionId: 'pool-a:mint-a',
          activeMint: 'mint-a',
          activePoolAddress: 'pool-a',
          lifecycleState: 'closed',
          importStatus: 'superseded_closed',
          supersededByPositionKey: 'chain-position:old-pos',
          lastAction: 'withdraw-lp',
          lastReason: 'superseded-by-chain-closed-position',
          lastClosedAt: '2026-07-02T15:05:00.000Z',
          updatedAt: '2026-07-02T15:05:00.000Z'
        }]
      },
      actionIdentity: {
        openIntentId: 'lp-open-intent:new',
        positionId: 'pool-a:mint-a'
      },
      orderIntent: {
        idempotencyKey: 'new-open',
        poolAddress: 'pool-a',
        tokenMint: 'mint-a'
      },
      action: 'add-lp',
      reason: 'live-order-submitted',
      liveOrderSubmitted: true,
      confirmationStatus: 'confirmed',
      confirmedFill: {
        submissionId: 'new-fill',
        filledSol: 0.1,
        fillAmountSource: 'wallet-delta',
        recordedAt: '2026-07-02T15:10:00.000Z'
      },
      now: '2026-07-02T15:10:01.000Z'
    });

    expect(ledger.records).toHaveLength(2);
    expect(ledger.records.find((record) => record.openIntentId === 'lp-open-intent:old')).toMatchObject({
      lifecycleState: 'closed',
      importStatus: 'superseded_closed'
    });
    expect(ledger.records.find((record) => record.openIntentId === 'lp-open-intent:new')).toMatchObject({
      positionKey: 'open-intent:lp-open-intent:new',
      lifecycleState: 'open',
      idempotencyKey: 'new-open'
    });
  });

  it('does not count records missing from chain as business-active LPs', () => {
    const ledger = {
      version: 1 as const,
      updatedAt: '2026-06-30T07:30:00.000Z',
      records: [
        {
          positionKey: 'chain-position:pos-missing',
          positionId: 'pos-missing',
          chainPositionAddress: 'pos-missing',
          activeMint: 'mint-missing',
          activePoolAddress: 'pool-missing',
          lifecycleState: 'open' as const,
          importStatus: 'imported' as const,
          lastAction: 'withdraw-lp',
          lastReason: 'live-order-submitted',
          missingOnChainSince: '2026-06-30T07:00:00.000Z',
          updatedAt: '2026-06-30T07:30:00.000Z'
        },
        {
          positionKey: 'chain-position:pos-active',
          positionId: 'pos-active',
          chainPositionAddress: 'pos-active',
          activeMint: 'mint-active',
          activePoolAddress: 'pool-active',
          lifecycleState: 'open' as const,
          importStatus: 'imported' as const,
          lastAction: 'add-lp',
          updatedAt: '2026-06-30T07:30:00.000Z'
        }
      ]
    };

    expect(summarizePositionLedger(ledger)).toEqual({
      activeLpCount: 1,
      chainActiveLpCount: 1,
      pendingOpenCount: 0,
      reconcileRequiredCount: 1,
      residualCleanupRequiredCount: 0,
      managedLpCount: 1,
      importFailedLpCount: 0
    });

    const state = selectCompatibilityPositionState({
      ledger,
      prior: null,
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      now: '2026-06-30T07:30:00.000Z'
    });

    expect(state.chainPositionAddress).toBe('pos-active');
    expect(state.activeMint).toBe('mint-active');
  });

  it('selects a ledger record atomically for compatibility position state', () => {
    const state = selectCompatibilityPositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'dca-out',
      lastReason: 'residual-cleanup-failed',
      walletSol: 0.27,
      now: '2026-06-29T17:48:01.000Z',
      prior: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'dca-out',
        activeMint: 'residual-mint',
        activePoolAddress: 'residual-pool',
        chainPositionAddress: 'pos-a',
        lifecycleState: 'open',
        updatedAt: '2026-06-29T17:47:00.000Z'
      },
      ledger: {
        version: 1,
        updatedAt: '2026-06-29T17:48:01.000Z',
        records: [{
          positionKey: 'chain-position:pos-a',
          positionId: 'pos-a',
          chainPositionAddress: 'pos-a',
          activeMint: 'lp-mint',
          activePoolAddress: 'lp-pool',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          entrySol: 0.1,
          updatedAt: '2026-06-29T17:48:01.000Z'
        }]
      }
    });

    expect(state).toMatchObject({
      chainPositionAddress: 'pos-a',
      activeMint: 'lp-mint',
      activePoolAddress: 'lp-pool',
      entrySol: 0.1
    });
    expect(state.activeMint).not.toBe('residual-mint');
  });
});
