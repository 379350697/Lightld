# Lightld Runtime Remediation Spec

## Goal

This document defines the consolidated remediation target for the current `lightld` repository as a personal-use Meteora SOL liquidity automation system.

The remediation goal is not to redesign the whole project. The goal is to make the current live path safer, more internally consistent, and easier to maintain while preserving the existing single-process daemon plus sidecar deployment style.

## Product Positioning

- Personal-use only.
- Live automation first.
- No simulation, paper runtime, or replay work is in scope for this remediation cycle.
- Whitelist-based gating is removed from the target operating model.
- Priority is: prevent unsafe live behavior, make runtime decisions auditable, then reduce maintenance drag.

## Current State Summary

The repository already has a reasonable top-level structure:

- `src/cli`: operational entrypoints
- `src/runtime`: live orchestration, mode/state, recovery
- `src/execution`: quote/sign/broadcast adapters and local/Solana execution services
- `src/ingest`: Meteora / Pump / GMGN inputs
- `src/strategy`: decision engines and filtering
- `src/risk`: live guards and limits
- `src/journals`: JSONL audit trails
- `src/observability`: SQLite mirror pipeline

The main problems are not missing layers. The main problems are:

1. critical live safety rules are not aligned with LP-mode actions
2. runtime guard semantics do not distinguish risk-increasing actions from risk-reducing actions
3. local execution contracts do not match the default LP-enabled strategy path
4. several configs, filters, and helper modules exist without full end-to-end effect
5. core orchestration files are too large, making state transitions hard to reason about

## Scope

This remediation covers the live runtime path end to end:

- strategy action generation
- runtime action policy
- live guard evaluation
- order intent semantics
- execution-side contract compatibility
- pending submission recovery behavior
- ingest candidate filtering that materially affects live picks
- test coverage for the above
- documentation and operational expectations

## Explicit Non-Goals

The following are out of scope for this remediation:

- adding simulation, paper trading, replay, or backtest capabilities
- introducing a full new architecture or multi-service rewrite
- building a generalized multi-user platform
- refactoring every large file in the repository
- changing the project away from Node.js / TypeScript

## Required Constraints

### 1. Live-first safety model

Any action that increases exposure must be treated differently from any action that reduces exposure.

At minimum:

- exposure-increasing: `deploy`, `add-lp`
- exposure-reducing: `dca-out`, `withdraw-lp`
- maintenance: `claim-fee`, `rebalance-lp`
- neutral/blocking: `hold`

Runtime policy, guards, spend accounting, journaling, and execution adapters must all use the same action semantics.

### 2. No whitelist dependency

Whitelist checks must not be required for the target live model.

This means:

- whitelist gating cannot be a prerequisite for order submission
- removing a token from a list must never block exits
- docs and config should stop presenting whitelist as a required live safety primitive

The project may keep compatibility shims temporarily, but the target behavior is whitelist-free.

### 3. No simulation dependency

There must be no required simulation path, paper path, or mock-only workflow in the core implementation plan.

Tests remain required. The restriction applies to product/runtime scope, not unit tests.

### 4. Sidecar and strategy compatibility

If the default strategy can emit LP actions, the supported live execution path must either:

- execute LP actions correctly, or
- fail fast at startup with an explicit incompatibility error

Silent contract drift is not acceptable.

## Current Problems To Resolve

### P0 Safety / Correctness

1. `flatten_only` and `circuit_open` do not fully block LP opening actions.
2. live guards block exits and maintenance actions using rules meant for opening exposure.
3. spend accounting records all submitted actions, including exits.
4. local execution sidecar only accepts `buy` / `sell`, while the default strategy can emit LP actions.

### P1 Consistency / Drift

1. ingest filtering does not fully enforce LP-related selection constraints from config.
2. strategy config schema, engine inputs, and runtime config passing are partially drifted.
3. order intent quantity semantics are inconsistent between upstream planning and downstream sell execution.

### P2 Maintainability

1. `live-cycle.ts` is too large and mixes unrelated responsibilities.
2. `ingest-context-builder.ts` mixes fetching, normalization, filtering, scoring, and selection.
3. debugging residue and low-value helper paths remain in core flow.

## Target Design

### A. Canonical action semantics

Introduce one canonical action classification layer used by runtime, guards, accounting, and execution.

Required categories:

- `open_risk`
- `reduce_risk`
- `maintain_position`
- `no_op`

All downstream decisions must consume this classification instead of duplicating ad hoc string checks.

### B. Guard behavior by action class

Only `open_risk` actions should be blocked by:

- position cap
- single-order spend limit
- daily spend limit
- session-open restrictions intended to prevent new entries

`reduce_risk` actions must remain executable even when opening is disallowed.

`maintain_position` actions must be explicitly classified, not implicitly treated as buys or sells.

### C. Unified live execution contract

The execution contract must be explicit about what each action means.

For each action, the system must define:

- required input fields
- whether amount means requested SOL in, requested SOL out, or full-position operation
- expected execution adapter behavior
- expected journal and mirror payloads

If a sell action is intentionally “sell all inventory”, that must be represented as such in the order contract and audit path instead of being hidden behind `outputSol`.

### D. Config surface must match real behavior

Any config exposed in YAML/schema must satisfy one of two conditions:

- it changes runtime behavior end to end, or
- it is removed

This especially applies to:

- LP selection thresholds
- LP management thresholds
- large-pool strategy thresholds
- legacy whitelist-oriented controls

### E. Focused orchestration boundaries

The current runtime may remain single-process, but its core files must be decomposed by responsibility.

Target boundary split:

- recovery and pending-submission handling
- strategy decision and action normalization
- runtime policy and guard evaluation
- order submission and confirmation
- journaling and mirror emission

## Acceptance Criteria

The remediation is complete when all of the following are true:

1. `add-lp` is blocked wherever opening new exposure is blocked.
2. `dca-out` and `withdraw-lp` remain executable when opening is blocked.
3. no live path requires whitelist membership.
4. spend accounting only records exposure-increasing actions.
5. local execution support is aligned with the default strategy path or fails fast with a clear incompatibility message.
6. LP pool selection config that remains in schema is enforced by live ingest selection.
7. order intent semantics are documented and reflected consistently in runtime and execution code.
8. new tests cover the corrected action-class behavior and contract boundaries.
9. docs stop implying that simulation or whitelist operation is part of the intended workflow.

## Validation Requirements

The following validation must exist before closing the remediation:

- typecheck/build passes
- targeted unit tests for runtime policy, live guards, spend accounting, and execution contract behavior
- targeted integration-style tests for LP-capable execution path or fail-fast startup validation
- targeted tests for ingest pool filtering behavior

Because the current environment used during the audit could not run Node-based commands due to a local WSL/Node issue, final implementation validation must be performed again in a working Node runtime.

## Implementation Priorities

Execution priority is:

1. fix live safety semantics
2. align execution contracts with emitted actions
3. remove config/behavior drift
4. split oversized orchestration units only where it directly reduces risk for the touched areas

## Notes For Implementation

- Follow existing repository patterns unless they directly conflict with the constraints above.
- Do not introduce simulation or paper-only branches as part of the fix.
- Prefer removing unused or misleading config over keeping inert abstraction.
- Every fix in the live path should leave behind focused tests and simpler decision boundaries.
