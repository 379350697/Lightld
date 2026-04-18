import type { LiveAccountState } from './live-account-provider.ts';

export type AccountEquitySummary = {
  walletSol: number | null;
  lpValueSol: number | null;
  unclaimedFeeSol: number | null;
  netWorthSol: number | null;
  openPositionCount: number | null;
};

export function summarizeAccountEquity(
  accountState?: Pick<LiveAccountState, 'walletSol' | 'walletLpPositions'> | null
): AccountEquitySummary {
  if (!accountState) {
    return {
      walletSol: null,
      lpValueSol: null,
      unclaimedFeeSol: null,
      netWorthSol: null,
      openPositionCount: null
    };
  }

  const activePositions = (accountState.walletLpPositions ?? []).filter((position) => position.hasLiquidity ?? true);
  let lpValueSol = 0;
  let unclaimedFeeSol = 0;

  for (const position of activePositions) {
    if (typeof position.currentValueSol === 'number' && Number.isFinite(position.currentValueSol)) {
      lpValueSol += position.currentValueSol;
    }

    if (typeof position.unclaimedFeeSol === 'number' && Number.isFinite(position.unclaimedFeeSol)) {
      unclaimedFeeSol += position.unclaimedFeeSol;
    }
  }

  const walletSol = Number.isFinite(accountState.walletSol) ? accountState.walletSol : null;

  return {
    walletSol,
    lpValueSol,
    unclaimedFeeSol,
    netWorthSol: walletSol === null ? null : walletSol + lpValueSol + unclaimedFeeSol,
    openPositionCount: activePositions.length
  };
}
