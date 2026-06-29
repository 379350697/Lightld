import { describe, expect, it } from 'vitest';

import { resolveMintPositionAggregate } from '../../../src/runtime/mint-position-aggregate';
import type { LiveAccountState } from '../../../src/runtime/live-account-provider';

function journal<T>(entries: T[]) {
  return {
    readAll: async () => entries
  } as any;
}

function accountWithResidualToken(currentValueSol?: number): LiveAccountState {
  return {
    walletSol: 1,
    journalSol: 1,
    walletTokens: [{
      mint: 'mint-residual',
      amount: 100,
      currentValueSol
    }],
    journalTokens: [],
    walletLpPositions: [],
    journalLpPositions: [],
    fills: []
  };
}

describe('mint position aggregate dust semantics', () => {
  it('does not require dust cleanup when residual value is unavailable', async () => {
    const result = await resolveMintPositionAggregate({
      mint: 'mint-residual',
      pendingSubmission: null,
      accountState: accountWithResidualToken(),
      lifecycleState: 'closed',
      orders: journal([]),
      fills: journal([]),
      residualTokenSweepMinValueSol: 0.1
    });

    expect(result.mustCleanupDust).toBe(false);
    expect(result.state).toBe('idle');
    expect(result.canOpen).toBe(true);
  });

  it('does not require dust cleanup when residual value is below threshold', async () => {
    const result = await resolveMintPositionAggregate({
      mint: 'mint-residual',
      pendingSubmission: null,
      accountState: accountWithResidualToken(0.01),
      lifecycleState: 'closed',
      orders: journal([]),
      fills: journal([]),
      residualTokenSweepMinValueSol: 0.1
    });

    expect(result.mustCleanupDust).toBe(false);
    expect(result.state).toBe('idle');
    expect(result.canOpen).toBe(true);
  });

  it('requires dust cleanup only when residual value reaches threshold', async () => {
    const result = await resolveMintPositionAggregate({
      mint: 'mint-residual',
      pendingSubmission: null,
      accountState: accountWithResidualToken(0.2),
      lifecycleState: 'closed',
      orders: journal([]),
      fills: journal([]),
      residualTokenSweepMinValueSol: 0.1
    });

    expect(result.mustCleanupDust).toBe(true);
    expect(result.state).toBe('dust_cleanup_pending');
    expect(result.canOpen).toBe(false);
  });
});
