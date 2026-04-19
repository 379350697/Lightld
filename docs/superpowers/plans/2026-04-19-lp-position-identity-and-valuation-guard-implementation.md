# LP Position Identity And Valuation Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LP TP/SL evaluation deterministic and safe by adding stable LP position identity, converging LP order/fill schemas across runtime and mirror surfaces, and blocking PnL-based exits whenever valuation inputs are unavailable or invalid.

**Architecture:** Keep the file-first runtime and journal pipeline, but stop deriving LP lifecycle facts from loose mint-level evidence. Introduce a position-scoped identity model (`openIntentId`, `positionId`, `chainPositionAddress`), move LP entry/timing/valuation facts onto that model, and make journaling, mirror replay, recovery, and dashboard readers consume one canonical LP schema. Add explicit valuation quality states so TP/SL only runs on trusted valuation inputs while non-PnL exits remain available.

**Tech Stack:** TypeScript, Zod, Vitest, JSONL journals, SQLite mirror, existing live runtime state snapshots

---

## File Map

**Create:**

- `src/runtime/lp-position-record.ts`
  Owns canonical LP identity/state types and helpers for `openIntentId`, `positionId`, `chainPositionAddress`, authoritative entry/timing facts, and valuation status.
- `src/runtime/lp-valuation.ts`
  Owns valuation-quality evaluation and the logic that decides whether LP PnL exits are eligible.

**Modify:**

- `src/runtime/state-types.ts`
  Extend pending submission and position state schemas with stable LP identity and valuation fields.
- `src/runtime/live-cycle.ts`
  Replace mint-wide LP fill heuristics with position-scoped reads, write canonical LP fill fields, and gate TP/SL on valuation readiness.
- `src/runtime/live-daemon.ts`
  Persist and recover canonical LP position records instead of fabricating `entrySol` and `openedAt`.
- `src/runtime/live-cycle-outcomes.ts`
  Propagate new LP identity fields into result objects and mirror payload builders.
- `src/runtime/live-account-provider.ts`
  Extend LP position payload typing to carry `positionAddress` consistently and any valuation metadata required by the new guard.
- `src/runtime/mint-position-aggregate.ts`
  Stop relying on legacy entry-fill assumptions once canonical LP fill fields exist.
- `src/execution/solana/meteora-dlmm-client.ts`
  Surface deterministic chain position binding hints and return explicit valuation-readiness signals instead of silent low-value fallbacks.
- `src/execution/solana/solana-execution-server.ts`
  Preserve LP open/close metadata needed for `openIntentId` to chain-position binding.
- `src/journals/live-fill-journal.ts`
  Preserve canonical LP fill schema and ensure rotated-history readers can replay it unchanged.
- `src/observability/mirror-events.ts`
  Extend order/fill payloads with LP identity fields.
- `src/observability/mirror-adapters.ts`
  Build mirror payloads from the canonical LP schema without lossy translation.
- `src/observability/mirror-catchup.ts`
  Replay legacy and new LP records into the canonical mirror event model.
- `src/observability/sqlite-mirror-schema.ts`
  Add LP identity / valuation columns for orders and fills if the schema is split there.
- `src/observability/sqlite-mirror-writer.ts`
  Write the new LP identity / valuation columns and keep old rows readable.
- `src/observability/mirror-query-service.ts`
  Return canonical LP fields to dashboard/status consumers.
- `src/dashboard/dashboard-server.ts`
  Read canonical LP state and stop falling back to guessed entry/open times where the new state exists.

**Test:**

- `tests/ts/runtime/live-cycle.test.ts`
- `tests/ts/runtime/live-daemon.test.ts`
- `tests/ts/runtime/pending-submission-store.test.ts`
- `tests/ts/runtime/pending-submission-recovery.test.ts`
- `tests/ts/observability/mirror-adapters.test.ts`
- `tests/ts/observability/mirror-catchup.test.ts`
- `tests/ts/observability/sqlite-mirror-writer.test.ts`
- `tests/ts/dashboard/dashboard-metrics.test.ts`
- `tests/ts/journals/live-fill-journal.test.ts`
- `tests/ts/risk/lp-pnl.test.ts`

## Canonical Structures To Implement

Use these shapes as the planning target.

```ts
type LpPositionIdentity = {
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
  poolAddress?: string;
  tokenMint?: string;
};

type LpValuationState = {
  valuationStatus?: 'ready' | 'unavailable' | 'stale' | 'invalid';
  valuationReason?: string;
  lastValuationAt?: string;
};

type CanonicalLpFillRecord = {
  cycleId?: string;
  strategyId?: string;
  submissionId?: string;
  confirmationSignature?: string;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
  mint: string;
  poolAddress?: string;
  symbol?: string;
  side: 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp' | 'buy' | 'sell';
  filledSol: number;
  requestedPositionSol?: number;
  confirmationStatus?: 'submitted' | 'confirmed' | 'failed' | 'unknown';
  recordedAt: string;
};
```

## Task 1: Lock the five failure modes with regression tests

**Files:**

- Modify: `tests/ts/runtime/live-cycle.test.ts`
- Modify: `tests/ts/runtime/live-daemon.test.ts`
- Modify: `tests/ts/observability/mirror-catchup.test.ts`
- Modify: `tests/ts/observability/mirror-adapters.test.ts`
- Modify: `tests/ts/journals/live-fill-journal.test.ts`

- [ ] **Step 1: Add a failing live-cycle test for repeated LP opens on the same mint**

Create a case where:

- two LP positions share the same mint
- the older fill belongs to a closed or different lifecycle
- the active chain position should use a later fill bound to its own lifecycle

Expected assertion:

```ts
expect(result.audit.reason).toContain('lp-take-profit');
expect(result.context?.trader?.lpNetPnlPct).toBeCloseTo(expectedCurrentLifecyclePnl);
```

- [ ] **Step 2: Run the targeted live-cycle test and verify it fails for the current mint-wide heuristic**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/live-cycle.test.ts`

Expected: FAIL because `live-cycle.ts` still picks the wrong fill or computes `holdTimeMs` from the wrong lifecycle.

- [ ] **Step 3: Add a failing recovery test proving `entrySol` is not allowed to fall back to `requestedPositionSol` or `currentValueSol - fee`**

Use a daemon recovery scenario with:

- existing LP chain position
- no trustworthy bound LP open fill
- `requestedPositionSol` present
- `currentValueSol` and `unclaimedFeeSol` present

Expected assertion:

```ts
expect(nextPositionState.entrySol).toBeUndefined();
expect(nextPositionState.lastReason).toContain('orphaned');
```

- [ ] **Step 4: Run the targeted daemon recovery test and verify it fails for the current inference path**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/live-daemon.test.ts`

Expected: FAIL because `live-daemon.ts` still infers `entrySol`.

- [ ] **Step 5: Add a failing mirror/journal replay test proving canonical LP fill fields survive round-trip**

Cover:

- journal write with `filledSol`, `openIntentId`, `positionId`
- mirror adapter emission
- catch-up replay from rotated files

Expected assertion:

```ts
expect(fillEvent.payload.filledSol).toBe(0.1);
expect(fillEvent.payload.positionId).toBe('position-1');
expect(fillEvent.payload.openIntentId).toBe('intent-1');
```

- [ ] **Step 6: Run the mirror and journal tests and verify they fail because the current adapters lose LP identity or still depend on `amount`**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/journals/live-fill-journal.test.ts tests/ts/observability/mirror-adapters.test.ts tests/ts/observability/mirror-catchup.test.ts`

Expected: FAIL because LP identity fields are absent and replay still depends on legacy field names.

- [ ] **Step 7: Add a failing valuation-guard test for unavailable valuation**

In `tests/ts/runtime/live-cycle.test.ts`, create a live LP position with:

- valid `entrySol` and `openedAt`
- missing or invalid `currentValueSol`
- active non-PnL guard available in a separate case

Expected assertions:

```ts
expect(result.action).not.toBe('withdraw-lp');
expect(result.reason).toContain('valuation-unavailable');
```

- [ ] **Step 8: Run the valuation-guard test and verify it fails because TP/SL still treats missing valuation as calculable**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/live-cycle.test.ts`

Expected: FAIL because the current runtime silently computes or skips without explicit valuation state.

- [ ] **Step 9: Commit the test-only regression lock**

```bash
git add tests/ts/runtime/live-cycle.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/observability/mirror-catchup.test.ts tests/ts/observability/mirror-adapters.test.ts tests/ts/journals/live-fill-journal.test.ts
git commit -m "test: lock LP identity and valuation regressions"
```

## Task 2: Introduce canonical LP identity and valuation types

**Files:**

- Create: `src/runtime/lp-position-record.ts`
- Create: `src/runtime/lp-valuation.ts`
- Modify: `src/runtime/state-types.ts`
- Modify: `src/runtime/live-account-provider.ts`

- [ ] **Step 1: Add a failing type/schema test for the new LP position state shape**

If no dedicated schema test exists, add one to `tests/ts/runtime/pending-submission-store.test.ts` or create a focused state-types test using:

```ts
expect(PositionStateSnapshotSchema.parse({
  allowNewOpens: true,
  flattenOnly: false,
  lastAction: 'add-lp',
  lifecycleState: 'open',
  openIntentId: 'intent-1',
  positionId: 'position-1',
  chainPositionAddress: 'chain-pos-1',
  valuationStatus: 'ready',
  valuationReason: '',
  updatedAt: '2026-04-19T00:00:00.000Z'
})).toMatchObject({
  openIntentId: 'intent-1',
  positionId: 'position-1'
});
```

- [ ] **Step 2: Run the focused schema test and verify it fails**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/pending-submission-store.test.ts`

Expected: FAIL because the new fields are not present in state schemas.

- [ ] **Step 3: Implement `lp-position-record.ts` with canonical LP identity helpers**

Include helpers for:

- generating `openIntentId`
- building/updating canonical position records
- reading authoritative `openedAt` / `entrySol`
- marking orphaned or unbound LP positions

- [ ] **Step 4: Implement `lp-valuation.ts` with valuation readiness evaluation**

Provide one focused entry point, for example:

```ts
export function evaluateLpValuationState(input: {
  currentValueSol?: number;
  unclaimedFeeSol?: number;
  hasClaimableFees?: boolean;
  pricePerToken?: number;
  tokenXDecimals?: number;
  tokenYDecimals?: number;
  observedAt: string;
}): {
  valuationStatus: 'ready' | 'unavailable' | 'stale' | 'invalid';
  valuationReason: string;
  lastValuationAt: string;
};
```

- [ ] **Step 5: Extend `state-types.ts` and `live-account-provider.ts` to carry the new fields**

Add:

- `openIntentId`
- `positionId`
- `chainPositionAddress`
- `valuationStatus`
- `valuationReason`
- `lastValuationAt`

Do not remove legacy fields yet; keep backward compatibility.

- [ ] **Step 6: Run the focused schema/runtime tests and verify they pass**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/pending-submission-store.test.ts tests/ts/runtime/live-account-provider.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the canonical type layer**

```bash
git add src/runtime/lp-position-record.ts src/runtime/lp-valuation.ts src/runtime/state-types.ts src/runtime/live-account-provider.ts tests/ts/runtime/pending-submission-store.test.ts tests/ts/runtime/live-account-provider.test.ts
git commit -m "feat: add canonical LP identity and valuation types"
```

## Task 3: Converge LP journal and mirror schemas

**Files:**

- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/runtime/live-cycle-outcomes.ts`
- Modify: `src/journals/live-fill-journal.ts`
- Modify: `src/observability/mirror-events.ts`
- Modify: `src/observability/mirror-adapters.ts`
- Modify: `src/observability/mirror-catchup.ts`
- Modify: `src/observability/sqlite-mirror-schema.ts`
- Modify: `src/observability/sqlite-mirror-writer.ts`

- [ ] **Step 1: Update the failing journal/mirror tests to target one canonical LP fill shape**

Assert this record shape end-to-end:

```ts
{
  openIntentId: 'intent-1',
  positionId: 'position-1',
  chainPositionAddress: 'chain-pos-1',
  filledSol: 0.1,
  requestedPositionSol: 0.1,
  confirmationStatus: 'confirmed'
}
```

- [ ] **Step 2: Run the LP journal/mirror test subset and verify it still fails**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/journals/live-fill-journal.test.ts tests/ts/observability/mirror-adapters.test.ts tests/ts/observability/mirror-catchup.test.ts tests/ts/observability/sqlite-mirror-writer.test.ts`

Expected: FAIL

- [ ] **Step 3: Make `live-cycle.ts` write canonical LP fill records**

Change LP fill writes so:

- `filledSol` always carries actual SOL-sized execution value
- LP mirror payloads do not zero-out the value in `amount`
- new identity fields are written together
- fill records are replayable without consulting unrelated order rows

- [ ] **Step 4: Extend mirror event types and adapters with LP identity fields**

Add `openIntentId`, `positionId`, and `chainPositionAddress` to fill/order payloads where relevant. Preserve backward compatibility by making the new fields optional at the event boundary until all call sites are updated.

- [ ] **Step 5: Update mirror catch-up and SQLite writer to read/write the canonical LP fields**

Rules:

- primary path reads canonical field names
- legacy fallback may map `amount` or other older names only in compatibility branches
- SQLite schema gets additive columns only

- [ ] **Step 6: Run the LP journal/mirror suite and verify it passes**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/journals/live-fill-journal.test.ts tests/ts/observability/mirror-adapters.test.ts tests/ts/observability/mirror-catchup.test.ts tests/ts/observability/sqlite-mirror-writer.test.ts tests/ts/observability/sqlite-mirror-retention.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the schema convergence**

```bash
git add src/runtime/live-cycle.ts src/runtime/live-cycle-outcomes.ts src/journals/live-fill-journal.ts src/observability/mirror-events.ts src/observability/mirror-adapters.ts src/observability/mirror-catchup.ts src/observability/sqlite-mirror-schema.ts src/observability/sqlite-mirror-writer.ts tests/ts/journals/live-fill-journal.test.ts tests/ts/observability/mirror-adapters.test.ts tests/ts/observability/mirror-catchup.test.ts tests/ts/observability/sqlite-mirror-writer.test.ts
git commit -m "feat: unify LP journal and mirror schemas"
```

## Task 4: Bind LP lifecycle state to `positionId` instead of mint-wide heuristics

**Files:**

- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/runtime/live-daemon.ts`
- Modify: `src/runtime/mint-position-aggregate.ts`
- Modify: `src/execution/solana/meteora-dlmm-client.ts`
- Modify: `src/execution/solana/solana-execution-server.ts`
- Modify: `tests/ts/runtime/live-cycle.test.ts`
- Modify: `tests/ts/runtime/live-daemon.test.ts`

- [ ] **Step 1: Add a failing test for deterministic chain-position binding**

Cover:

- `openIntentId` generated at LP open
- later chain position observation binds `positionId`
- future ticks read `entrySol`, `openedAt`, and `holdTimeMs` from that bound position instead of scanning fills by mint

- [ ] **Step 2: Run the focused LP lifecycle test and verify it fails**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/live-cycle.test.ts tests/ts/runtime/live-daemon.test.ts`

Expected: FAIL

- [ ] **Step 3: Capture the earliest trustworthy chain binding hint from Meteora execution**

Implementation guidance:

- if `addLiquidityByStrategy()` exposes a newly created position keypair or deterministic address, persist it alongside the open intent
- otherwise bind on first matching `positionAddress` observed from account state

- [ ] **Step 4: Replace mint-wide LP fill lookup with position-scoped lookup in `live-cycle.ts`**

Specifically remove the current primary dependency on:

```ts
fill.mint === mint && (fill.side === 'add-lp' || fill.side === 'buy')
```

and replace it with:

- bound `positionId`
- bound `chainPositionAddress`
- lifecycle-specific canonical LP open fill

- [ ] **Step 5: Replace recovery inference in `live-daemon.ts`**

Rules:

- no recovery-time `entrySol = requestedPositionSol`
- no recovery-time `entrySol = currentValueSol - unclaimedFeeSol`
- unresolved live LP positions become explicitly orphaned/unbound

- [ ] **Step 6: Update mint aggregation to recognize confirmed LP entries from canonical fills**

Keep compatibility with older records, but stop letting mint-only evidence drive authoritative state once canonical LP identity exists.

- [ ] **Step 7: Run the LP runtime test subset and verify it passes**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/live-cycle.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/pending-submission-recovery.test.ts tests/ts/runtime/live-cycle-production.test.ts`

Expected: PASS

- [ ] **Step 8: Commit the LP identity binding work**

```bash
git add src/runtime/live-cycle.ts src/runtime/live-daemon.ts src/runtime/mint-position-aggregate.ts src/execution/solana/meteora-dlmm-client.ts src/execution/solana/solana-execution-server.ts tests/ts/runtime/live-cycle.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/pending-submission-recovery.test.ts tests/ts/runtime/live-cycle-production.test.ts
git commit -m "feat: bind LP lifecycle state to canonical position IDs"
```

## Task 5: Add valuation readiness gates and explicit unavailable-valuation behavior

**Files:**

- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/runtime/lp-valuation.ts`
- Modify: `src/execution/solana/meteora-dlmm-client.ts`
- Modify: `src/dashboard/dashboard-server.ts`
- Modify: `tests/ts/runtime/live-cycle.test.ts`
- Modify: `tests/ts/risk/lp-pnl.test.ts`

- [ ] **Step 1: Add a failing runtime test for valuation-unavailable TP/SL blocking**

Cover both:

- missing/invalid valuation blocks TP/SL and emits incident/audit
- non-PnL exit such as `lp-sol-nearly-depleted` still works under valuation unavailable

- [ ] **Step 2: Run the targeted valuation test and verify it fails**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/live-cycle.test.ts tests/ts/risk/lp-pnl.test.ts`

Expected: FAIL

- [ ] **Step 3: Make Meteora valuation explicit instead of silently low-valued**

Implementation guidance:

- if price/decimals are missing, return valuation status metadata instead of silently dropping the non-SOL leg
- only produce `valuationStatus: 'ready'` when the conversion inputs are trustworthy
- if fees are absent but `hasClaimableFees` is false, allow `unclaimedFeeSol = 0`; otherwise mark unavailable

- [ ] **Step 4: Gate LP PnL exits in `live-cycle.ts` on `valuationStatus === 'ready'`**

Add explicit audit details such as:

```ts
`valuationStatus=${valuationStatus}`,
`valuationReason=${valuationReason}`
```

and emit an incident for unavailable/invalid valuation.

- [ ] **Step 5: Update dashboard/status readers to expose valuation state**

Show the operator whether LP TP/SL was skipped because valuation was unavailable rather than simply "not triggered."

- [ ] **Step 6: Run the valuation-focused suite and verify it passes**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/live-cycle.test.ts tests/ts/risk/lp-pnl.test.ts tests/ts/dashboard/dashboard-metrics.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the valuation guard**

```bash
git add src/runtime/live-cycle.ts src/runtime/lp-valuation.ts src/execution/solana/meteora-dlmm-client.ts src/dashboard/dashboard-server.ts tests/ts/runtime/live-cycle.test.ts tests/ts/risk/lp-pnl.test.ts tests/ts/dashboard/dashboard-metrics.test.ts
git commit -m "feat: gate LP TP/SL on valuation readiness"
```

## Task 6: Complete migration coverage and end-to-end verification

**Files:**

- Modify: `src/observability/mirror-query-service.ts`
- Modify: `src/dashboard/dashboard-server.ts`
- Modify: `tests/ts/observability/mirror-query-service.test.ts`
- Modify: `tests/ts/runtime/live-daemon.test.ts`
- Modify: `tests/ts/runtime/live-cycle.test.ts`
- Modify: `tests/ts/observability/sqlite-mirror-writer.test.ts`

- [ ] **Step 1: Add compatibility tests for legacy LP records**

Cover:

- old records lacking `positionId`
- old fill rows using legacy names
- dashboard/mirror queries still readable after additive schema migration

- [ ] **Step 2: Run the compatibility test subset and verify it fails if compatibility is missing**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/observability/mirror-query-service.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle.test.ts tests/ts/observability/sqlite-mirror-writer.test.ts`

Expected: FAIL if legacy adapters were not wired in.

- [ ] **Step 3: Implement legacy read adapters without polluting the primary write path**

Rules:

- write path only emits canonical fields
- read path may map old names only in narrow compatibility helpers
- compatibility must never recreate guessed `entrySol`

- [ ] **Step 4: Run the full focused verification suite**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm test -- tests/ts/runtime/live-cycle.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle-production.test.ts tests/ts/runtime/pending-submission-recovery.test.ts tests/ts/journals/live-fill-journal.test.ts tests/ts/observability/mirror-adapters.test.ts tests/ts/observability/mirror-catchup.test.ts tests/ts/observability/sqlite-mirror-writer.test.ts tests/ts/observability/mirror-query-service.test.ts tests/ts/dashboard/dashboard-metrics.test.ts tests/ts/risk/lp-pnl.test.ts`

Expected: PASS

- [ ] **Step 5: Run the typecheck**

Run: `"/mnt/c/Windows/System32/cmd.exe" /c npm run build`

Expected: PASS

- [ ] **Step 6: Commit the migration and verification pass**

```bash
git add src/observability/mirror-query-service.ts src/dashboard/dashboard-server.ts tests/ts/observability/mirror-query-service.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle.test.ts tests/ts/observability/sqlite-mirror-writer.test.ts
git commit -m "chore: finalize LP identity and valuation guard rollout"
```
