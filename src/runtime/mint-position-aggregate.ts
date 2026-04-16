import type { LiveAccountState } from './live-account-provider.ts';
import type { PendingSubmissionSnapshot, PositionLifecycleState } from './state-types.ts';
import { LiveOrderJournal } from '../journals/live-order-journal.ts';
import { LiveFillJournal } from '../journals/live-fill-journal.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);

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

function hasNonStableBalance(accountState: LiveAccountState | undefined, mint: string) {
  return Boolean(
    accountState?.walletTokens?.some(
      (token) => token.mint === mint && token.amount > 0 && token.mint !== SOL_MINT && !STABLE_MINTS.has(token.mint)
    )
  );
}

function hasAnyBalance(accountState: LiveAccountState | undefined, mint: string) {
  return Boolean(
    accountState?.walletTokens?.some((token) => token.mint === mint && token.amount > 0) ||
    accountState?.journalTokens?.some((token) => token.mint === mint && token.amount > 0) ||
    accountState?.walletLpPositions?.some((position) => position.mint === mint) ||
    accountState?.journalLpPositions?.some((position) => position.mint === mint)
  );
}

export async function resolveMintPositionAggregate(input: {
  mint: string;
  pendingSubmission: PendingSubmissionSnapshot | null;
  accountState?: LiveAccountState;
  lifecycleState: PositionLifecycleState;
  orders: LiveOrderJournal<JsonLike>;
  fills: LiveFillJournal<JsonLike>;
}): Promise<MintPositionAggregate> {
  const mint = input.mint;
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
  const hasInventory = hasAnyBalance(input.accountState, mint);
  const hasDustInventory = hasNonStableBalance(input.accountState, mint);

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
