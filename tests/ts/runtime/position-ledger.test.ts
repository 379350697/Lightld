import { describe, expect, it } from 'vitest';

import {
  applyLiveCycleResultToLedger,
  importActiveLpPositionsToLedger,
  migratePositionStateToLedger,
  selectCompatibilityPositionState
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
