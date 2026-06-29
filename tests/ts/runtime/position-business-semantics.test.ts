import { describe, expect, it } from 'vitest';

import {
  isPositionAlreadyClosedTerminal,
  resolvePositionBusinessSemantics
} from '../../../src/runtime/position-business-semantics';
import type { LiveAccountState } from '../../../src/runtime/live-account-provider';

function baseAccount(overrides: Partial<LiveAccountState> = {}): LiveAccountState {
  return {
    walletSol: 1,
    journalSol: 1,
    walletTokens: [],
    journalTokens: [],
    walletLpPositions: [],
    journalLpPositions: [],
    fills: [],
    ...overrides
  };
}

describe('position business semantics', () => {
  it('allows new opens while active LP capacity remains available', () => {
    const result = resolvePositionBusinessSemantics({
      maxActivePositions: 2,
      positionLedger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-active',
          positionId: 'pos-active',
          chainPositionAddress: 'pos-active',
          activeMint: 'mint-active',
          activePoolAddress: 'pool-active',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }]
      },
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'hold',
        lifecycleState: 'open',
        activeMint: 'mint-active',
        activePoolAddress: 'pool-active',
        chainPositionAddress: 'pos-active',
        updatedAt: '2026-06-29T00:00:00.000Z'
      },
      accountState: baseAccount({
        walletLpPositions: [{
          poolAddress: 'pool-active',
          positionAddress: 'pos-active',
          mint: 'mint-active',
          hasLiquidity: true
        }]
      })
    });

    expect(result.nextAction).toBe('maintain');
    expect(result.canOpenNewPosition).toEqual({
      allowed: true,
      reason: 'capacity-available'
    });
    expect(result.canRunNewOpenAfterMaintenance).toEqual({
      allowed: true,
      reason: 'capacity-available'
    });
  });

  it('allows new opens after an unsubmitted residual dca-out failure when LP capacity remains', () => {
    const result = resolvePositionBusinessSemantics({
      maxActivePositions: 5,
      maintenanceOutcome: {
        action: 'dca-out',
        liveOrderSubmitted: false,
        reason: 'swap-provider-chain-execute-failed: route-not-found'
      },
      positionLedger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-active',
          positionId: 'pos-active',
          chainPositionAddress: 'pos-active',
          activeMint: 'mint-active',
          activePoolAddress: 'pool-active',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }]
      },
      accountState: baseAccount({
        walletLpPositions: [{
          poolAddress: 'pool-active',
          positionAddress: 'pos-active',
          mint: 'mint-active',
          hasLiquidity: true
        }]
      })
    });

    expect(result.maintenanceIntent).toBe('residual-cleanup');
    expect(result.canOpenNewPosition).toEqual({
      allowed: true,
      reason: 'capacity-available'
    });
    expect(result.canRunNewOpenAfterMaintenance).toEqual({
      allowed: true,
      reason: 'capacity-available'
    });
  });

  it('blocks new opens after a submitted maintenance order', () => {
    const result = resolvePositionBusinessSemantics({
      maxActivePositions: 5,
      maintenanceOutcome: {
        action: 'withdraw-lp',
        liveOrderSubmitted: true,
        reason: 'live-order-submitted'
      },
      positionLedger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-active',
          positionId: 'pos-active',
          chainPositionAddress: 'pos-active',
          activeMint: 'mint-active',
          activePoolAddress: 'pool-active',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }]
      },
      accountState: baseAccount({
        walletLpPositions: [{
          poolAddress: 'pool-active',
          positionAddress: 'pos-active',
          mint: 'mint-active',
          hasLiquidity: true
        }]
      })
    });

    expect(result.maintenanceIntent).toBe('lp-exit');
    expect(result.canRunNewOpenAfterMaintenance).toEqual({
      allowed: false,
      reason: 'maintenance-order-submitted'
    });
  });

  it('blocks new opens after an unsubmitted LP exit while allowing residual cleanup failures to stay non-blocking', () => {
    const commonInput = {
      maxActivePositions: 5,
      positionLedger: {
        version: 1 as const,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-active',
          positionId: 'pos-active',
          chainPositionAddress: 'pos-active',
          activeMint: 'mint-active',
          activePoolAddress: 'pool-active',
          lifecycleState: 'open' as const,
          lastAction: 'add-lp',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }]
      },
      accountState: baseAccount({
        walletLpPositions: [{
          poolAddress: 'pool-active',
          positionAddress: 'pos-active',
          mint: 'mint-active',
          hasLiquidity: true
        }]
      })
    };

    const lpExitFailure = resolvePositionBusinessSemantics({
      ...commonInput,
      maintenanceOutcome: {
        action: 'withdraw-lp',
        liveOrderSubmitted: false,
        reason: 'withdraw-target-valuation-unavailable',
        failureKind: 'hard'
      }
    });
    const residualFailure = resolvePositionBusinessSemantics({
      ...commonInput,
      maintenanceOutcome: {
        action: 'dca-out',
        liveOrderSubmitted: false,
        reason: 'swap-provider-chain-execute-failed: route-not-found',
        failureKind: 'transient'
      }
    });

    expect(lpExitFailure.canOpenNewPosition).toEqual({
      allowed: true,
      reason: 'capacity-available'
    });
    expect(lpExitFailure.canRunNewOpenAfterMaintenance).toEqual({
      allowed: false,
      reason: 'maintenance-lp-exit-not-submitted:withdraw-target-valuation-unavailable'
    });
    expect(residualFailure.canRunNewOpenAfterMaintenance).toEqual({
      allowed: true,
      reason: 'capacity-available'
    });
  });

  it('blocks new opens only when active LP capacity is full', () => {
    const result = resolvePositionBusinessSemantics({
      maxActivePositions: 1,
      positionLedger: {
        version: 1,
        updatedAt: '2026-06-29T00:00:00.000Z',
        records: [{
          positionKey: 'chain-position:pos-orphan',
          positionId: 'pos-orphan',
          chainPositionAddress: 'pos-orphan',
          activeMint: 'mint-orphan',
          activePoolAddress: 'pool-orphan',
          lifecycleState: 'open',
          lastAction: 'add-lp',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }]
      },
      accountState: baseAccount({
        walletLpPositions: [{
          poolAddress: 'pool-orphan',
          positionAddress: 'pos-orphan',
          mint: 'mint-orphan',
          hasLiquidity: true
        }]
      })
    });

    expect(result.nextAction).toBe('maintain');
    expect(result.canOpenNewPosition).toEqual({
      allowed: false,
      reason: 'position-capacity-full'
    });
  });

  it('allows new opens when the account is flat and residual dust is below threshold', () => {
    const result = resolvePositionBusinessSemantics({
      residualTokenSweepMinValueSol: 0.1,
      accountState: baseAccount({
        walletTokens: [{
          mint: 'mint-dust',
          amount: 1,
          currentValueSol: 0.00001
        }]
      })
    });

    expect(result.residualDustState).toBe('dust_ignored');
    expect(result.canOpenNewPosition).toEqual({
      allowed: true,
      reason: 'flat-dust-ignored'
    });
  });

  it('does not block new opens for residual dust without valuation evidence', () => {
    const result = resolvePositionBusinessSemantics({
      residualTokenSweepMinValueSol: 0.1,
      accountState: baseAccount({
        walletTokens: [{
          mint: 'mint-no-route-dust',
          amount: 1
        }]
      })
    });

    expect(result.residualDustState).toBe('dust_ignored');
    expect(result.canOpenNewPosition).toEqual({
      allowed: true,
      reason: 'flat-dust-ignored'
    });
  });

  it('keeps valuable residual inventory in cleanup semantics without treating it as an LP', () => {
    const result = resolvePositionBusinessSemantics({
      residualTokenSweepMinValueSol: 0.1,
      accountState: baseAccount({
        walletTokens: [{
          mint: 'mint-residual',
          amount: 1,
          currentValueSol: 0.2
        }]
      })
    });

    expect(result.hasActiveLp).toBe(false);
    expect(result.nextAction).toBe('cleanup-dust');
    expect(result.canOpenNewPosition).toEqual({
      allowed: false,
      reason: 'residual-dust-cleanup-pending'
    });
  });

  it('treats claim-fee as pending maintenance instead of pending exit', () => {
    const result = resolvePositionBusinessSemantics({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'claim-fee-1',
        submissionId: 'sub-claim-fee',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-06-29T00:00:00.000Z',
        updatedAt: '2026-06-29T00:00:00.000Z',
        tokenMint: 'mint-active',
        tokenSymbol: 'SAFE',
        poolAddress: 'pool-active',
        orderAction: 'claim-fee',
        reason: 'lp-claim-fee'
      }
    });

    expect(result.hasPendingExit).toBe(false);
    expect(result.hasPendingMaintenance).toBe(true);
    expect(result.canOpenNewPosition).toEqual({
      allowed: false,
      reason: 'pending-maintenance'
    });
  });

  it('treats pending dca-out as residual cleanup instead of LP exit', () => {
    const result = resolvePositionBusinessSemantics({
      pendingSubmission: {
        strategyId: 'new-token-v1',
        idempotencyKey: 'dca-out-1',
        submissionId: 'sub-dca-out',
        confirmationStatus: 'submitted',
        finality: 'processed',
        createdAt: '2026-06-29T00:00:00.000Z',
        updatedAt: '2026-06-29T00:00:00.000Z',
        tokenMint: 'mint-residual',
        tokenSymbol: 'RES',
        poolAddress: '',
        orderAction: 'dca-out',
        reason: 'residual-cleanup'
      }
    });

    expect(result.hasPendingExit).toBe(false);
    expect(result.hasPendingResidualCleanup).toBe(true);
    expect(result.pendingState).toBe('residual-cleanup');
    expect(result.canOpenNewPosition).toEqual({
      allowed: false,
      reason: 'pending-residual-cleanup'
    });
  });

  it('treats position-already-closed as terminal only when the matching LP is gone', () => {
    const positionState = {
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'withdraw-lp',
      lifecycleState: 'open' as const,
      activeMint: 'mint-active',
      activePoolAddress: 'pool-active',
      chainPositionAddress: 'pos-active',
      updatedAt: '2026-06-29T00:00:00.000Z'
    };

    expect(isPositionAlreadyClosedTerminal({
      action: 'withdraw-lp',
      reason: 'position-already-closed:Position not found for pool',
      positionState,
      accountState: baseAccount()
    })).toBe(true);

    expect(isPositionAlreadyClosedTerminal({
      action: 'withdraw-lp',
      reason: 'position-already-closed:Position not found for pool',
      positionState,
      accountState: baseAccount({
        walletLpPositions: [{
          poolAddress: 'pool-active',
          positionAddress: 'pos-active',
          mint: 'mint-active',
          hasLiquidity: true
        }]
      })
    })).toBe(false);

    expect(isPositionAlreadyClosedTerminal({
      action: 'claim-fee',
      reason: 'position-already-closed:Position not found for pool',
      positionState,
      accountState: baseAccount()
    })).toBe(false);
  });
});
