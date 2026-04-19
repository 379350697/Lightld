# LP Position Identity And Valuation Guard Design

**Goal:** Eliminate LP TP/SL misfires caused by position misidentification, schema drift, recovery-time guessing, and silent valuation errors by introducing stable position identity, unified journal/mirror schemas, and explicit valuation-quality guards.

## Problem

The current LP exit path has five coupled failure modes:

1. `entrySol` and `holdTimeMs` can be derived from the wrong fill because the runtime still falls back to "same mint, earliest open fill" logic.
2. Journals, mirror payloads, catch-up replay, and runtime fill readers do not share one canonical LP fill schema, so a fill can be written successfully but become unreadable to later recovery or TP/SL evaluation.
3. Recovery paths can recreate `entrySol` from `requestedPositionSol` or from `currentValueSol - unclaimedFeeSol`, which is not a trustworthy historical cost basis.
4. `pendingConfirmationStatus` and `holdTimeMs` are not consistently attached to one durable LP position lifecycle, so TP guardrails may read mismatched state.
5. `currentValueSol` and `unclaimedFeeSol` can be silently understated when Meteora valuation inputs are missing or invalid, which can suppress TP or trigger SL from bad data.

The user wants all five fixed together, not as isolated patches.

## Options Considered

### 1. Patch the current mint-based flow

Keep the existing mint/pool matching model and only repair the obvious field mismatches.

Pros:

- smallest short-term diff
- lowest immediate migration cost

Cons:

- does not give LP positions a stable primary key
- still relies on inference during recovery
- does not fully solve repeated opens on the same mint
- makes future debugging harder because identity remains implicit

### 2. Add stable LP position identity and unify schemas

Introduce a local open-intent ID and a durable LP position ID, then make journals, state, mirror, and replay consume one shared schema. Add explicit valuation quality gates so PnL-based exits only run on trusted inputs.

Pros:

- directly addresses all five root causes
- keeps the trading path understandable and file-first
- preserves current runtime architecture while making recovery deterministic
- gives audits one stable key for every LP lifecycle

Cons:

- requires coordinated changes across runtime, journals, mirror, and tests
- needs migration logic for older records without the new IDs

### 3. Build a separate position ledger subsystem first

Create a new ledger service/module as the only authority for all LP lifecycle state, and migrate all runtime reads to it immediately.

Pros:

- cleanest long-term architecture
- strongest separation between runtime logic and state derivation

Cons:

- largest implementation scope
- highest regression surface for this round
- slower path to fixing urgent TP/SL risk

## Chosen Design

Choose **option 2**.

It is the smallest design that fully closes the current safety holes without forcing a full subsystem rewrite. The runtime remains file-first and journal-first, but LP lifecycle state becomes explicit and position-scoped instead of inferred from loose mint-level evidence.

## Design

### 1. Stable identity model

Introduce two durable IDs:

- `openIntentId`: generated locally when the runtime decides to open an LP position
- `positionId`: generated when the system recognizes a durable LP lifecycle and bound to one chain-side position

Also persist:

- `chainPositionAddress`: the Meteora `positionAddress` once known
- `poolAddress`
- `tokenMint`

Rules:

- every LP open attempt gets one `openIntentId`
- every successful durable LP position gets one `positionId`
- one `positionId` may reference one `openIntentId`, but replays/recovery must continue to use `positionId` as the lifecycle key after the chain position is known
- TP/SL, hold-time tracking, fee claims, rebalances, and LP withdrawals must read by `positionId`, not by mint-wide earliest fill

This turns LP lifecycle state from "best guess by mint" into "one explicit position record."

### 2. Chain binding flow

The runtime should bind local intent to chain evidence in stages:

1. decision time: create `openIntentId`
2. broadcast time: write `openIntentId` into pending submission, order journal, and fill journal
3. execution/account-state time: detect the created or matched Meteora `positionAddress`
4. binding time: create or update `positionId` and persist `chainPositionAddress`
5. steady state: all future LP lifecycle reads use `positionId`

If `addLiquidityByStrategy()` returns a new position keypair or equivalent deterministic position address, capture that immediately as the preferred binding hint. If it is not available at broadcast time, bind on the first later account-state observation of a matching live chain position.

### 3. Unified LP schema

LP-related persistence surfaces must converge on one canonical field set. The same semantics should exist in:

- pending submission state
- live order journal
- live fill journal
- position state / runtime state
- mirror events
- SQLite mirror rows
- mirror catch-up adapters
- recovery readers

Minimum shared fields:

- `openIntentId`
- `positionId`
- `chainPositionAddress`
- `submissionId`
- `confirmationSignature`
- `strategyId`
- `poolAddress`
- `tokenMint`
- `tokenSymbol`
- `action`
- `requestedPositionSol`
- `filledSol`
- `recordedAt`
- `confirmationStatus`

Position-state-specific fields:

- `openedAt`
- `entrySol`
- `valuationStatus`
- `valuationReason`
- `lastValuationAt`

Rules:

- LP fills must use `filledSol` as the actual SOL-sized execution value
- replay/read paths must no longer depend on `amount` for LP fill recovery
- mirror and journal adapters must preserve the same meaning for all LP fields
- legacy fallback adapters may read older field names, but only in migration code, not in the primary path

### 4. Position-scoped entry and timing

`entrySol` and `openedAt` must be attached to `positionId`, not recomputed from loose evidence on every tick.

Authoritative sources for `entrySol`, in order:

1. confirmed LP open fill bound to the same `positionId`
2. persisted position ledger/state for that `positionId`
3. explicit migration record created from old trusted history

Disallowed primary sources:

- earliest fill for same mint only
- `requestedPositionSol` as a substitute for a real confirmed LP fill
- `currentValueSol - unclaimedFeeSol`

`holdTimeMs` must always be computed from `openedAt` for that `positionId`.

This removes the current "same mint, earliest fill" failure mode and prevents repeated opens on the same mint from corrupting TP/SL inputs.

### 5. Valuation quality guard

PnL-based exits must only run when valuation inputs are trustworthy.

Add `valuationStatus` on each LP position snapshot:

- `ready`
- `unavailable`
- `stale`
- `invalid`

Add `valuationReason` for operator visibility, for example:

- `missing-current-value`
- `missing-unclaimed-fee`
- `missing-decimals`
- `invalid-price`
- `sdk-valuation-failed`

Rules:

- if `currentValueSol` is missing, invalid, negative, or derived from invalid conversion inputs, mark valuation unavailable
- if fee valuation is missing but the position valuation is otherwise trustworthy, preserve a policy choice:
  - either treat fee as unavailable and block PnL exits
  - or explicitly treat fee as `0` only when the SDK positively reports no claimable fees
- if price or decimals are unavailable for pair-to-SOL conversion, do not silently drop the non-SOL leg and continue as if the result were trustworthy
- PnL-based TP/SL must not run unless `valuationStatus === 'ready'`

This closes the silent-undervaluation failure mode.

### 6. Exit policy with unavailable valuation

When valuation is unavailable:

- do not run LP TP
- do not run LP SL
- emit an incident and structured audit message
- continue to allow non-PnL exits that do not require valuation, such as:
  - `max-hold`
  - `lp-sol-nearly-depleted`
  - explicit out-of-range rebalance/withdraw rules

The user explicitly approved this policy so that bad valuation data cannot silently produce false TP/SL outcomes.

### 7. Recovery behavior

Recovery must become explicit instead of inferential.

Rules:

- on restart, first restore known `positionId` records from state/journals
- then rebind them to current chain positions using `chainPositionAddress`
- if a live LP position exists but no trustworthy `positionId` binding can be made, mark it as an orphaned LP position and emit an incident
- orphaned positions may still be visible to the operator and may still participate in non-PnL exits if the chain-side position facts allow that safely
- orphaned positions must not fabricate `entrySol`

This replaces hidden recovery-time guessing with visible state that operators can inspect.

## Data Flow

### LP open

1. runtime decides to open LP
2. generate `openIntentId`
3. write order/pending records with `openIntentId`
4. broadcast and write fill record with canonical LP fill schema
5. bind resulting chain position to `positionId`
6. persist `entrySol`, `openedAt`, and chain binding on that `positionId`

### LP maintenance and exit evaluation

1. account-state provides live LP positions
2. runtime matches each chain position to `positionId`
3. runtime attaches valuation status and valuation reason
4. if valuation ready, compute `lpNetPnlPct` from trusted inputs
5. if valuation unavailable, skip PnL exits and emit incident/audit
6. evaluate remaining non-PnL guards

### Restart / recovery

1. load persisted `positionId` records
2. load live chain positions
3. rebind by `chainPositionAddress`
4. restore `openedAt`, `entrySol`, and lifecycle status from persisted records
5. mark unmatched live chain positions as orphaned instead of guessing

## Testing Strategy

Add or update tests for:

1. repeated LP opens on the same mint do not reuse the wrong fill
2. fill journals, mirror payloads, and catch-up replay all preserve canonical LP fill fields
3. runtime recovery never recreates `entrySol` from `requestedPositionSol` or `currentValueSol - fee`
4. TP requires trusted valuation and the correct `positionId`-scoped `openedAt` / confirmation state
5. valuation-unavailable positions skip TP/SL but still emit incidents and remain eligible for non-PnL exits
6. old rotated journal records still bind to the correct `positionId`
7. mixed legacy records can be read through migration adapters without poisoning the new primary path

## Migration Notes

Existing records will not all contain the new IDs. Migration should therefore:

- preserve backward-compatible readers for historical records
- derive transitional `positionId` bindings only from trusted historical evidence
- never elevate guessed `entrySol` into authoritative new position state
- prefer "orphaned/unbound" over "guessed and possibly wrong"

## Non-Goals

This design does not:

- replace the file-first runtime with a database-first runtime
- auto-close orphaned positions without existing exit rules
- redesign the entire Meteora valuation engine beyond the guardrails required for trusted TP/SL
- expand the scope to unrelated strategies

## Success Criteria

The design is successful when:

- every active LP lifecycle has a stable position identity
- LP fill/order/state/mirror records share one canonical schema
- TP/SL no longer depends on mint-wide earliest-fill heuristics
- recovery never fabricates cost basis from current valuation or requested size
- valuation failures are explicit and observable instead of silently participating in TP/SL
- all five known LP TP/SL risk categories are covered by tests and pass
