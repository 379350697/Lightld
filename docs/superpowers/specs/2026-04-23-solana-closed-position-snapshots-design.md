# Solana Closed Position Snapshots Design

## Goal

Make `Historical positions` use chain-reconstructed closed-position truth for the live wallet instead of local order/fill/decision estimates.

The first success target is one concrete lifecycle: `earthcoin / SOL`.

## Scope

In scope:

- Reconstruct closed LP lifecycle metrics from Solana transaction history for the cloud live wallet
- Persist reconstructed closed-position snapshots locally
- Make dashboard history prefer reconstructed closed-position snapshots over local estimated history

Out of scope:

- USD valuation
- Meteora private/frontend API scraping
- Multi-wallet support
- Replacing open-position valuation logic

## Data Model

Add a new persisted record for chain truth:

- `walletAddress`
- `tokenMint`
- `poolAddress`
- `positionAddress`
- `openedAt`
- `closedAt`
- `depositSol`
- `depositTokenAmount`
- `withdrawSol`
- `withdrawTokenAmount`
- `feeSol`
- `feeTokenAmount`
- `pnlSol`
- `source` = `solana-chain`
- `confidence` = `exact` or `partial`

`pnlSol` is defined as:

`withdrawSol + withdrawTokenValueSol + feeSol + feeTokenValueSol - depositSol`

This project will use SOL as the only base value. No USD fields will be stored.

## Reconstruction Strategy

Primary source:

- Solana `getSignaturesForAddress`
- Solana `getTransaction`

Reconstruction rules:

- Identify LP lifecycle transactions for the live wallet
- Treat LP open as deposit
- Treat LP withdraw as principal withdrawal
- Treat fee claim as realized fee
- Group transactions by `positionAddress` when available, otherwise by a fallback lifecycle key built from wallet + pool + token + time adjacency

For token-side values:

- Prefer transaction-native balance deltas when they fully describe the event
- If a lifecycle step leaves only token units without direct SOL output, convert that token amount into SOL using the transaction-time pool-side exchange ratio available from the same transaction context

## Dashboard Rules

`Historical positions` should:

- Prefer `closed_position_snapshots`
- Show `source = solana-chain`
- Stop presenting local estimated PnL as if it were exact truth

If no chain snapshot exists for a lifecycle, the row should not claim exact PnL.

## Implementation Plan

1. Build a Solana closed-position snapshot collector for the live wallet
2. Persist snapshots into local SQLite
3. Add dashboard query path for closed-position snapshots
4. Make history API and UI prefer chain truth
5. Verify `earthcoin` matches chain truth and no longer depends on decision fallback estimates

## Verification

Success criteria:

- We can reconstruct one `earthcoin` closed lifecycle from chain data
- Dashboard `/api/history` returns the `earthcoin` row from `solana-chain`
- Historical PnL is no longer derived from `decision audit` percentage fallback for that row
