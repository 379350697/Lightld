import type { LiveAccountState } from './live-account-provider.ts';
import type { PendingSubmissionSnapshot } from './state-types.ts';

export function matchesPendingLpEvidence(
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'tokenMint' | 'poolAddress' | 'chainPositionAddress'>,
  position: { mint: string; poolAddress: string; positionAddress?: string; chainPositionAddress?: string }
) {
  if (pendingSubmission.chainPositionAddress) {
    return position.positionAddress === pendingSubmission.chainPositionAddress
      || position.chainPositionAddress === pendingSubmission.chainPositionAddress;
  }

  if (pendingSubmission.tokenMint && pendingSubmission.poolAddress) {
    return position.mint === pendingSubmission.tokenMint
      && position.poolAddress === pendingSubmission.poolAddress;
  }

  // Single-field matching remains useful as positive recovery evidence for
  // legacy open intents.  It must never be used as negative close proof;
  // hasFreshCompleteLpExitAbsenceEvidence requires a strong address or the
  // complete pool+mint pair before absence is considered terminal.
  if (pendingSubmission.tokenMint) {
    return position.mint === pendingSubmission.tokenMint;
  }

  return Boolean(
    pendingSubmission.poolAddress
    && position.poolAddress === pendingSubmission.poolAddress
  );
}

export function hasCompleteFreshAccountSnapshot(
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'createdAt'>,
  accountState: LiveAccountState | undefined
) {
  if (
    !accountState?.observedAt
    || !Array.isArray(accountState.walletLpPositions)
    || !Array.isArray(accountState.journalLpPositions)
    || !Array.isArray(accountState.walletTokens)
    || !Array.isArray(accountState.journalTokens)
    || !Array.isArray(accountState.fills)
  ) {
    return false;
  }

  const observedAtMs = Date.parse(accountState.observedAt);
  const submittedAtMs = Date.parse(pendingSubmission.createdAt);
  return Number.isFinite(observedAtMs)
    && Number.isFinite(submittedAtMs)
    && observedAtMs > submittedAtMs;
}

export function hasFreshCompleteLpExitAbsenceEvidence(
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'createdAt' | 'tokenMint' | 'poolAddress' | 'chainPositionAddress'>,
  accountState: LiveAccountState | undefined
) {
  const hasExactIdentity = Boolean(
    pendingSubmission.chainPositionAddress
    || (pendingSubmission.tokenMint && pendingSubmission.poolAddress)
  );
  return hasExactIdentity
    && hasCompleteFreshAccountSnapshot(pendingSubmission, accountState)
    && !hasWalletLpEvidence(pendingSubmission, accountState);
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
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'tokenMint' | 'poolAddress' | 'chainPositionAddress'>,
  accountState: LiveAccountState | undefined
) {
  if (!pendingSubmission.tokenMint && !pendingSubmission.poolAddress && !pendingSubmission.chainPositionAddress) {
    return false;
  }

  return Boolean(
    accountState?.walletLpPositions?.some((position) =>
      matchesPendingLpEvidence(pendingSubmission, position) && (position.hasLiquidity ?? true)
    )
  );
}

export function hasAnyWalletEvidenceForPendingSubmission(
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'tokenMint' | 'poolAddress' | 'chainPositionAddress'>,
  accountState: LiveAccountState | undefined
) {
  if (!pendingSubmission.tokenMint && !pendingSubmission.poolAddress && !pendingSubmission.chainPositionAddress) {
    return false;
  }

  return hasWalletTokenEvidence(pendingSubmission.tokenMint, accountState) ||
    hasWalletLpEvidence(pendingSubmission, accountState);
}

export function hasFullyFundedWalletLpEvidence(
  pendingSubmission: Pick<PendingSubmissionSnapshot, 'tokenMint' | 'poolAddress' | 'chainPositionAddress'>,
  accountState: LiveAccountState | undefined
) {
  if (!pendingSubmission.tokenMint && !pendingSubmission.poolAddress && !pendingSubmission.chainPositionAddress) {
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
