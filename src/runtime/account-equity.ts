import type { LiveAccountState } from './live-account-provider.ts';
import { isManageableLpPosition } from './lp-position-visibility.ts';

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

  const activePositions = (accountState.walletLpPositions ?? []).filter((position) => isManageableLpPosition(position));
  let lpValueSol = 0;
  let unclaimedFeeSol = 0;

  for (const position of activePositions) {
    const positionValueSol = typeof position.lpTotalValueSol === 'number' && Number.isFinite(position.lpTotalValueSol)
      ? position.lpTotalValueSol
      : typeof position.currentValueSol === 'number' && Number.isFinite(position.currentValueSol)
        ? position.currentValueSol
        : undefined;

    if (typeof positionValueSol === 'number') {
      lpValueSol += positionValueSol;
    }

    const unclaimedFeeValueSol = typeof position.unclaimedFeeValueSol === 'number'
      && Number.isFinite(position.unclaimedFeeValueSol)
      ? position.unclaimedFeeValueSol
      : typeof position.unclaimedFeeSol === 'number' && Number.isFinite(position.unclaimedFeeSol)
        ? position.unclaimedFeeSol
        : undefined;

    if (typeof unclaimedFeeValueSol === 'number') {
      unclaimedFeeSol += unclaimedFeeValueSol;
    }
  }

  const walletSol = Number.isFinite(accountState.walletSol) ? accountState.walletSol : null;

  return {
    walletSol,
    lpValueSol,
    unclaimedFeeSol,
    netWorthSol: walletSol === null ? null : walletSol + lpValueSol,
    openPositionCount: activePositions.length
  };
}
