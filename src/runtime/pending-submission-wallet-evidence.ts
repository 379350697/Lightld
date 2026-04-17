import type { LiveAccountState } from './live-account-provider.ts';
import type { PendingSubmissionSnapshot } from './state-types.ts';

export function matchesPendingLpEvidence(
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'tokenMint' | 'poolAddress'>,
  position: { mint: string; poolAddress: string }
) {
  if (pendingSubmission.tokenMint && position.mint === pendingSubmission.tokenMint) {
    return true;
  }

  if (pendingSubmission.poolAddress && position.poolAddress === pendingSubmission.poolAddress) {
    return true;
  }

  return false;
}

export function hasWalletTokenEvidence(tokenMint: string | undefined, accountState: LiveAccountState | undefined) {
  if (!tokenMint) {
    return false;
  }

  return Boolean(
    accountState?.walletTokens?.some((token) => token.mint === tokenMint && token.amount > 0)
  );
}

export function hasWalletLpEvidence(
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'tokenMint' | 'poolAddress'>,
  accountState: LiveAccountState | undefined
) {
  if (!pendingSubmission.tokenMint && !pendingSubmission.poolAddress) {
    return false;
  }

  return Boolean(
    accountState?.walletLpPositions?.some((position) =>
      matchesPendingLpEvidence(pendingSubmission, position) && (position.hasLiquidity ?? true)
    )
  );
}

export function hasAnyWalletEvidenceForPendingSubmission(
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'tokenMint' | 'poolAddress'>,
  accountState: LiveAccountState | undefined
) {
  if (!pendingSubmission.tokenMint && !pendingSubmission.poolAddress) {
    return false;
  }

  return hasWalletTokenEvidence(pendingSubmission.tokenMint, accountState) ||
    hasWalletLpEvidence(pendingSubmission, accountState);
}

export function hasFullyFundedWalletLpEvidence(
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'tokenMint' | 'poolAddress'>,
  accountState: LiveAccountState | undefined
) {
  if (!pendingSubmission.tokenMint && !pendingSubmission.poolAddress) {
    return false;
  }

  return Boolean(
    accountState?.walletLpPositions?.some((position) => {
      if (!matchesPendingLpEvidence(pendingSubmission, position) || !(position.hasLiquidity ?? true)) {
        return false;
      }

      if (typeof position.binCount === 'number' && typeof position.fundedBinCount === 'number' && position.binCount > 0) {
        return position.fundedBinCount >= position.binCount;
      }

      return true;
    })
  );
}
