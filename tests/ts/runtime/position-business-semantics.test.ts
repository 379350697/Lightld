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
  it('blocks new opens while a managed LP is active', () => {
    const result = resolvePositionBusinessSemantics({
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
      allowed: false,
      reason: 'active-managed-lp'
    });
  });

  it('blocks new opens and selects exit semantics while an untracked LP is active', () => {
    const result = resolvePositionBusinessSemantics({
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'hold',
        lifecycleState: 'closed',
        updatedAt: '2026-06-29T00:00:00.000Z'
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

    expect(result.nextAction).toBe('exit');
    expect(result.untrackedActiveLpPositions).toHaveLength(1);
    expect(result.canOpenNewPosition).toEqual({
      allowed: false,
      reason: 'active-untracked-lp'
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
