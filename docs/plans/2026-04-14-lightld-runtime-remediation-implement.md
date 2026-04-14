# Lightld Runtime Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current live Meteora automation path safe for personal live use without simulation or whitelist dependency, while aligning runtime policy, guards, execution contracts, and ingest behavior.

**Architecture:** Keep the existing single-process daemon plus sidecar model, but normalize action semantics first and then route policy, guards, accounting, and execution through that shared meaning. Remove or connect drifted configuration so the codebase exposes only behavior that really exists.

**Tech Stack:** Node.js, TypeScript, Vitest, Zod, existing JSONL journals, existing local/Solana execution services.

---

## File Structure

### Core files to modify

- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/runtime/runtime-action-policy.ts`
- Modify: `src/risk/live-guards.ts`
- Modify: `src/risk/spending-limits.ts`
- Modify: `src/execution/order-intent-builder.ts`
- Modify: `src/execution/local-live-execution-server.ts`
- Modify: `src/execution/local-live-signer-server.ts`
- Modify: `src/execution/solana/solana-execution-server.ts`
- Modify: `src/runtime/ingest-context-builder.ts`
- Modify: `src/strategy/engine-runner.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/strategies/new-token-v1.yaml`
- Modify: `README.md`

### New files to create

- Create: `src/runtime/action-semantics.ts`

### Tests to modify or add

- Modify: `tests/ts/runtime/runtime-action-policy.test.ts`
- Modify: `tests/ts/risk/live-guards.test.ts`
- Modify: `tests/ts/runtime/live-cycle.test.ts`
- Modify: `tests/ts/runtime/live-cycle-production.test.ts`
- Modify: `tests/ts/execution/local-live-execution-server.test.ts`
- Modify: `tests/ts/execution/build-execution-plan.test.ts`
- Create or modify: `tests/ts/runtime/action-semantics.test.ts`
- Create or modify: `tests/ts/runtime/ingest-context-builder.test.ts`

## Task 1: Normalize action semantics

**Status:** Complete

**Files:**

- Create: `src/runtime/action-semantics.ts`
- Modify: `src/runtime/runtime-action-policy.ts`
- Test: `tests/ts/runtime/action-semantics.test.ts`
- Test: `tests/ts/runtime/runtime-action-policy.test.ts`

- [x] **Step 1: Write failing tests for canonical action classification**

Add tests that assert:

- `deploy` and `add-lp` classify as exposure-increasing
- `dca-out` and `withdraw-lp` classify as exposure-reducing
- `claim-fee` and `rebalance-lp` classify as maintenance
- `hold` classifies as no-op

- [x] **Step 2: Run targeted tests and confirm they fail**

Run: `npm test -- --run tests/ts/runtime/action-semantics.test.ts tests/ts/runtime/runtime-action-policy.test.ts`

Expected: failures due to missing action semantics module and incomplete policy coverage.

- [x] **Step 3: Implement `src/runtime/action-semantics.ts`**

Add a small focused module exporting:

- the canonical action union source
- `classifyAction(action)`
- helpers such as `isExposureIncreasingAction(action)` and `isExposureReducingAction(action)`

Keep this module string-based and dependency-free.

- [x] **Step 4: Update runtime policy to use canonical helpers**

Change `applyRuntimeActionPolicy` so:

- `paused` still blocks all execution
- `recovering` blocks new opens but allows exposure reduction
- `circuit_open` blocks exposure-increasing actions including `add-lp`
- `flatten_only` blocks exposure-increasing actions including `add-lp`
- maintenance actions are explicitly handled instead of relying on fallthrough

- [x] **Step 5: Re-run targeted tests and confirm they pass**

Run: `npm test -- --run tests/ts/runtime/action-semantics.test.ts tests/ts/runtime/runtime-action-policy.test.ts`

Expected: PASS.

## Task 2: Remove whitelist dependency and fix guard semantics

**Status:** Complete

**Files:**

- Modify: `src/risk/live-guards.ts`
- Modify: `src/runtime/live-cycle.ts`
- Test: `tests/ts/risk/live-guards.test.ts`
- Test: `tests/ts/runtime/live-cycle.test.ts`

- [x] **Step 1: Write failing tests for guard behavior by action class**

Add coverage that proves:

- exit actions are allowed when session is closed
- exit actions are allowed when daily spend is exhausted
- exit actions are allowed even if a symbol would previously have failed whitelist logic
- open actions are still blocked by position and spend limits

- [x] **Step 2: Run targeted tests and confirm they fail**

Run: `npm test -- --run tests/ts/risk/live-guards.test.ts tests/ts/runtime/live-cycle.test.ts`

Expected: failures showing exits are still blocked by generic guard rules.

- [x] **Step 3: Refactor `evaluateLiveGuards` to accept action semantics**

Change input shape to include either:

- the concrete action, or
- the normalized action class

Required behavior:

- remove whitelist as a required live gate
- apply spend and position rules only to exposure-increasing actions
- allow exposure-reducing actions under `flatten_only`/closed-style conditions
- keep kill-switch behavior explicit

- [x] **Step 4: Update `runLiveCycle` to pass normalized semantics into guards**

Ensure guard calls happen after action normalization and before order intent creation.

- [x] **Step 5: Re-run targeted tests and confirm they pass**

Run: `npm test -- --run tests/ts/risk/live-guards.test.ts tests/ts/runtime/live-cycle.test.ts`

Expected: PASS.

## Task 3: Fix spend accounting so only opening risk is counted

**Status:** Complete

**Files:**

- Modify: `src/risk/spending-limits.ts`
- Modify: `src/runtime/live-cycle.ts`
- Test: `tests/ts/risk/spending-limits.test.ts`
- Test: `tests/ts/runtime/live-cycle-production.test.ts`

- [x] **Step 1: Write failing tests for exit-safe spend accounting**

Add tests that verify:

- `deploy` and `add-lp` increase daily spend
- `dca-out` and `withdraw-lp` do not increase daily spend
- a blocked exit cannot be caused by daily spend rules

- [x] **Step 2: Run targeted tests and confirm they fail**

Run: `npm test -- --run tests/ts/risk/spending-limits.test.ts tests/ts/runtime/live-cycle-production.test.ts`

Expected: failures due to unconditional spend accounting and generic guard behavior.

- [x] **Step 3: Update runtime accounting call sites**

Use action semantics so `recordSpend(requestedPositionSol)` is only called for exposure-increasing actions.

- [x] **Step 4: Keep storage format stable unless a schema change is required**

Do not redesign `spending-limits.json`. Only change behavior needed for correct semantics.

- [x] **Step 5: Re-run targeted tests and confirm they pass**

Run: `npm test -- --run tests/ts/risk/spending-limits.test.ts tests/ts/runtime/live-cycle-production.test.ts`

Expected: PASS.

## Task 4: Align local execution contracts with LP-capable strategy output

**Status:** Complete

**Files:**

- Modify: `src/execution/local-live-execution-server.ts`
- Modify: `src/execution/local-live-signer-server.ts`
- Modify: `src/execution/order-intent-builder.ts`
- Modify: `src/runtime/live-cycle.ts`
- Test: `tests/ts/execution/local-live-execution-server.test.ts`
- Test: `tests/ts/runtime/live-cycle-production.test.ts`

- [x] **Step 1: Write failing tests for LP action contract compatibility**

Add tests that prove:

- local signer accepts `add-lp`, `withdraw-lp`, `claim-fee`, `rebalance-lp`
- local execution path either accepts the same set or fails fast before runtime submission begins

- [x] **Step 2: Decide contract strategy in code before implementation**

Preferred implementation:

- local execution sidecar supports the same action enum as signer and runtime

Fallback only if necessary:

- startup validation rejects LP-enabled strategy plus LP-incompatible execution path with an explicit error

- [x] **Step 3: Implement the chosen compatibility strategy**

If supporting LP actions in the local sidecar:

- expand schema enums
- persist action values in submissions
- make confirmation/account-state behavior remain compatible

If fail-fast:

- validate at startup or before live submission
- emit a clear, deterministic error message

- [x] **Step 4: Re-run targeted tests and confirm they pass**

Run: `npm test -- --run tests/ts/execution/local-live-execution-server.test.ts tests/ts/runtime/live-cycle-production.test.ts`

Expected: PASS.

## Task 5: Clarify order intent semantics for exit behavior

**Status:** Complete

**Files:**

- Modify: `src/execution/order-intent-builder.ts`
- Modify: `src/execution/solana/solana-execution-server.ts`
- Modify: `src/runtime/live-cycle.ts`
- Test: `tests/ts/execution/build-execution-plan.test.ts`
- Test: `tests/ts/runtime/live-cycle.test.ts`

- [x] **Step 1: Write failing tests for order intent meaning**

Cover:

- buy/open actions use the requested SOL amount as explicit open size
- sell/exit actions clearly express whether they are partial exits or full-position exits
- journal data matches the execution contract meaning

- [x] **Step 2: Implement explicit exit semantics**

Recommended approach:

- add an explicit field or action metadata indicating `fullPositionExit: true` for `dca-out` / `withdraw-lp` where appropriate
- stop relying on `outputSol` to imply both “requested trade size” and “full liquidation”

- [x] **Step 3: Update Solana executor to consume the explicit contract**

Make sell behavior deterministic and aligned with the declared intent.

- [x] **Step 4: Re-run targeted tests and confirm they pass**

Run: `npm test -- --run tests/ts/execution/build-execution-plan.test.ts tests/ts/runtime/live-cycle.test.ts`

Expected: PASS.

## Task 6: Remove config/behavior drift in strategy and ingest

**Status:** Complete

**Files:**

- Modify: `src/runtime/ingest-context-builder.ts`
- Modify: `src/strategy/engine-runner.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/strategies/new-token-v1.yaml`
- Test: `tests/ts/runtime/ingest-context-builder.test.ts`
- Test: `tests/ts/strategy/engine-runner.test.ts`
- Test: `tests/ts/strategy/dlmm-pool-filter.test.ts`

- [x] **Step 1: Write failing tests for config fields that must have real effect**

Add coverage proving that retained LP selection fields actually change candidate selection behavior.

- [x] **Step 2: Choose one of two cleanup paths and implement it consistently**

Recommended path:

- keep only config fields that already have live value for this personal-use strategy
- wire LP selection thresholds into ingest candidate filtering before final selection

Allowed simplification:

- remove unused config fields from schema/engine/runtime if they are not needed now

- [x] **Step 3: Refactor ingest selection minimally**

Split logic only enough to make these stages obvious:

- raw fetch
- normalization
- candidate hard filtering
- scoring
- final selection

Do not do a repo-wide architecture rewrite here.

- [x] **Step 4: Re-run targeted tests and confirm they pass**

Run: `npm test -- --run tests/ts/runtime/ingest-context-builder.test.ts tests/ts/strategy/engine-runner.test.ts tests/ts/strategy/dlmm-pool-filter.test.ts`

Expected: PASS.

## Task 7: Trim live-path garbage and improve docs

**Status:** Complete

Completed in this cycle:

- removed low-value recovery debug output and dead whitelist path residue
- updated README to reflect personal-use, live-first, no-whitelist, no-simulation operation
- decomposed `live-cycle.ts` and `ingest-context-builder.ts` into focused helpers, including action semantics, candidate selection, preflight checks, and outcome builders
- ran full validation in a working Windows Node runtime via npm CLI entrypoint:
  - `npm run build`
  - `npm test -- --run`

**Files:**

- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/runtime/ingest-context-builder.ts`
- Modify: `README.md`

- [x] **Step 1: Remove low-value debug residue**

Delete or replace:

- raw `console.log('!!! RECOVERY !!!', recovery)`
- dead local values such as ignored pump wallet trade normalization results

- [x] **Step 2: Update docs to match the target model**

README must clearly state:

- live-first personal-use operation
- no simulation/paper path in scope
- whitelist is not required for live operation
- local execution compatibility expectations for LP-capable strategies

- [x] **Step 3: Run the highest-signal validation commands**

Run:

- `npm run build`
- `npm test -- --run`

Expected:

- typecheck/build passes
- test suite passes

If the local environment still fails before repo code runs, document the exact environment blocker and re-run in a working Node environment.

## Definition of Done

- [x] Action semantics are centralized and reused.
- [x] Opening-risk actions are the only actions blocked by open-risk guards and spend limits.
- [x] Exit actions are never blocked by removed whitelist logic.
- [x] Spend accounting excludes exits.
- [x] Local execution is compatible with LP-capable strategy output or rejects it explicitly at startup.
- [x] Remaining config fields all have real effect.
- [x] Debug residue in core live flow is removed.
- [x] README reflects the real operating model.
- [x] `npm run build` and `npm test -- --run` succeed in a working Node runtime.
