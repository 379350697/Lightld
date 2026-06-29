import type { LiveAccountState } from './live-account-provider.ts';
import type { PendingSubmissionSnapshot, PositionLifecycleState } from './state-types.ts';
import { LiveOrderJournal } from '../journals/live-order-journal.ts';
import { LiveFillJournal } from '../journals/live-fill-journal.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);
const DEFAULT_RESIDUAL_TOKEN_SWEEP_MIN_VALUE_SOL = 0.1;

type JsonLike = Record<string, unknown>;

export type MintAggregateState =
  | 'idle'
  | 'open_pending'
  | 'open_active'
  | 'exit_pending'
  | 'dust_cleanup_pending'
  | 'closed';

export type MintPositionAggregate = {
  mint: string;
  state: MintAggregateState;
  hasPendingOpen: boolean;
  hasPendingExit: boolean;
  hasLpLikeOpenOrder: boolean;
  hasEntryFill: boolean;
  hasExitFill: boolean;
  hasInventory: boolean;
  hasDustInventory: boolean;
  canOpen: boolean;
  mustExit: boolean;
  mustCleanupDust: boolean;
  reason: string;
};

function isEntrySide(side: unknown) {
  return side === 'add-lp' || side === 'deploy' || side === 'buy';
}

function isExitSide(side: unknown) {
  return side === 'withdraw-lp' || side === 'dca-out' || side === 'sell';
}

function hasActionableResidualBalance(input: {
  accountState?: LiveAccountState;
  mint: string;
  residualTokenSweepMinValueSol: number;
}) {
  return Boolean(
    [
      ...(input.accountState?.walletTokens ?? []),
      ...(input.accountState?.journalTokens ?? [])
    ].some(
      (token) => token.mint === input.mint
        && token.amount > 0
        && token.mint !== SOL_MINT
        && !STABLE_MINTS.has(token.mint)
        && typeof token.currentValueSol === 'number'
        && Number.isFinite(token.currentValueSol)
        && token.currentValueSol >= input.residualTokenSweepMinValueSol
    )
  );
}

function hasActionableBalance(input: {
  accountState?: LiveAccountState;
  mint: string;
  residualTokenSweepMinValueSol: number;
}) {
  return Boolean(
    input.accountState?.walletTokens?.some((token) =>
      token.mint === input.mint
      && token.amount > 0
      && (
        token.mint === SOL_MINT
        || STABLE_MINTS.has(token.mint)
        || (
          typeof token.currentValueSol === 'number'
          && Number.isFinite(token.currentValueSol)
          && token.currentValueSol >= input.residualTokenSweepMinValueSol
        )
      )
    ) ||
    input.accountState?.journalTokens?.some((token) =>
      token.mint === input.mint
      && token.amount > 0
      && (
        token.mint === SOL_MINT
        || STABLE_MINTS.has(token.mint)
        || (
          typeof token.currentValueSol === 'number'
          && Number.isFinite(token.currentValueSol)
          && token.currentValueSol >= input.residualTokenSweepMinValueSol
        )
      )
    ) ||
    input.accountState?.walletLpPositions?.some((position) => position.mint === input.mint && (position.hasLiquidity ?? true)) ||
    input.accountState?.journalLpPositions?.some((position) => position.mint === input.mint && (position.hasLiquidity ?? true))
  );
}

export async function resolveMintPositionAggregate(input: {
  mint: string;
  pendingSubmission: PendingSubmissionSnapshot | null;
  accountState?: LiveAccountState;
  lifecycleState: PositionLifecycleState;
  orders: LiveOrderJournal<JsonLike>;
  fills: LiveFillJournal<JsonLike>;
  residualTokenSweepMinValueSol?: number;
}): Promise<MintPositionAggregate> {
  const mint = input.mint;
  const residualTokenSweepMinValueSol = input.residualTokenSweepMinValueSol
    ?? DEFAULT_RESIDUAL_TOKEN_SWEEP_MIN_VALUE_SOL;
  if (!mint) {
    return {
      mint,
      state: 'idle',
      hasPendingOpen: false,
      hasPendingExit: false,
      hasLpLikeOpenOrder: false,
      hasEntryFill: false,
      hasExitFill: false,
      hasInventory: false,
      hasDustInventory: false,
      canOpen: true,
      mustExit: false,
      mustCleanupDust: false,
      reason: 'empty-mint'
    };
  }

  const [orders, fills] = await Promise.all([input.orders.readAll(), input.fills.readAll()]);
  const mintOrders = orders.filter((entry) => entry?.tokenMint === mint);
  const mintFills = fills.filter((entry) => entry?.mint === mint);

  const hasPendingOpen = input.pendingSubmission?.tokenMint === mint && input.lifecycleState !== 'lp_exit_pending' && input.lifecycleState !== 'inventory_exit_pending';
  const hasPendingExit = input.pendingSubmission?.tokenMint === mint && (
    input.lifecycleState === 'lp_exit_pending' || input.lifecycleState === 'inventory_exit_pending'
  );
  const hasLpLikeOpenOrder = mintOrders.some((entry) => isEntrySide(entry?.side));
  const hasEntryFill = mintFills.some((entry) => isEntrySide(entry?.side));
  const hasConfirmedEntryFill = mintFills.some((entry) => isEntrySide(entry?.side) && entry?.confirmationStatus === 'confirmed');
  const hasExitFill = mintFills.some((entry) => isExitSide(entry?.side));
  const hasInventory = hasActionableBalance({
    accountState: input.accountState,
    mint,
    residualTokenSweepMinValueSol
  });
  const hasDustInventory = hasActionableResidualBalance({
    accountState: input.accountState,
    mint,
    residualTokenSweepMinValueSol
  });

  let state: MintAggregateState = 'idle';
  let reason = 'no-evidence';

  if (hasPendingExit) {
    state = 'exit_pending';
    reason = 'pending-exit';
  } else if (hasDustInventory) {
    state = 'dust_cleanup_pending';
    reason = 'non-stable-inventory-present';
  } else if (hasPendingOpen) {
    state = 'open_pending';
    reason = `pending-open:${input.pendingSubmission?.confirmationStatus ?? 'unknown'}`;
  } else if (hasInventory) {
    state = 'open_active';
    reason = 'inventory-present';
  } else if (hasExitFill) {
    state = 'closed';
    reason = 'exit-fill-present';
  } else if (hasConfirmedEntryFill) {
    state = 'closed';
    reason = 'historical-confirmed-entry-only';
  } else if (hasEntryFill || hasLpLikeOpenOrder) {
    state = 'closed';
    reason = 'historical-unconfirmed-entry-only';
  }

  const canOpen = state === 'idle' || state === 'closed';
  const mustCleanupDust = state === 'dust_cleanup_pending';
  const mustExit = state === 'open_active' || state === 'dust_cleanup_pending' || state === 'exit_pending';

  return {
    mint,
    state,
    hasPendingOpen,
    hasPendingExit,
    hasLpLikeOpenOrder,
    hasEntryFill,
    hasExitFill,
    hasInventory,
    hasDustInventory,
    canOpen,
    mustExit,
    mustCleanupDust,
    reason
  };
}
