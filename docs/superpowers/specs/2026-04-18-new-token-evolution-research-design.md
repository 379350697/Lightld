# New Token Evolution Research Design

**Goal:** Add a `new-token-v1`-focused research and self-evolution sidecar that analyzes candidate filtering, exit thresholds, and LP/bin behavior, then produces evidence-backed YAML patch drafts without affecting the live trading path.

## Problem

`Lightld` already has a solid live-only runtime:

- ingest-backed candidate selection
- strategy config in YAML
- live guards and runtime-mode safety controls
- JSONL journals for decisions, quotes, orders, fills, and incidents
- an optional SQLite mirror and operator dashboard

What it does not have is a native research layer that can answer questions like:

- which tokens were filtered out but later showed better follow-through
- whether `minLiquidityUsd`, LP eligibility gates, or safety filters are too strict or too loose
- whether `takeProfitPct` / `stopLossPct` or LP net-PnL exits are leaving too early or too late
- whether `solDepletionExitBins` and related bin settings are consistently lagging or overreacting
- how to keep following a token after the runtime first sees it so there is enough sample history to make future parameter decisions

The user wants a stronger “self-evolution” system, but with one hard constraint: it must never get decision power inside the main trading path.

## Design

Add a dedicated `evolution` research layer that sits beside the runtime instead of inside it.

The runtime remains responsible only for:

- trading decisions
- safety gates
- journaling
- optional SQLite mirroring

The new research layer is responsible only for:

- collecting structured candidate and token-follow-up samples
- building offline evidence windows
- evaluating filter, exit, and LP/bin behavior
- generating parameter proposals and YAML patch drafts
- recording approval and outcome history

It has no authority to:

- change runtime behavior at tick time
- modify runtime mode or live guards
- auto-apply config changes
- trigger reloads or execute remediation actions

## Scope

Phase 1 is intentionally limited to:

- strategy: `new-token-v1`
- proposal target: YAML parameters only
- output mode: `report + catalog + approval state + patch draft`
- approval mode: human review required before any config change

Included analysis domains:

- candidate filtering and candidate selection effectiveness
- take-profit / stop-loss effectiveness
- LP net-PnL and bin-related exit effectiveness
- watchlist follow-up after first observation

Not included:

- automatic config application
- automatic runtime reload
- online self-tuning during live ticks
- changes to runtime safety gates or recovery logic
- `large-pool-v1`

## Architecture

### High-level shape

Use a “research sidecar” pattern:

1. the live daemon emits richer structured evidence as best-effort side effects
2. the evidence is stored in JSONL and optionally mirrored into SQLite
3. offline CLIs read those artifacts and build reports
4. parameter proposals produce YAML patch drafts only after evidence thresholds are met
5. humans approve and manually apply changes
6. later report runs evaluate outcomes and keep an audit trail

This mirrors the safe parts of `LightFee`’s evolution flow, but it is adapted to `Lightld`’s token/LP strategy model instead of its arbitrage engine.

### Module layout

Add a new `src/evolution/` package with focused files:

- `types.ts`: research sample, proposal, approval, and outcome types
- `candidate-sample-store.ts`: append/read candidate scan samples
- `watchlist-store.ts`: append/read watchlist snapshots and tracked tokens
- `filter-analysis.ts`: evaluate filter effectiveness and missed-opportunity patterns
- `outcome-analysis.ts`: evaluate TP/SL and LP/bin exit behavior
- `proposal-engine.ts`: turn evidence into parameter and system proposals
- `patch-draft.ts`: generate YAML patch drafts and baseline checks
- `report-render.ts`: emit markdown/json report artifacts
- `approval-store.ts`: approval queue and outcome ledger helpers

Add CLI entrypoints:

- `src/cli/run-evolution-report-main.ts`
- `src/cli/run-evolution-approval-main.ts`

Phase 1 can keep approval/outcome commands behind the report CLI if that is lighter for the repo’s conventions, but the storage model should still separate report generation from approval state.

## Runtime Integration Points

### 1. Candidate scan evidence from ingest

`src/runtime/ingest-context-builder.ts` is the primary intake point for filter analysis because it sees:

- the raw candidate pool
- safety-filter diagnostics
- LP-eligibility filtering
- final selection
- block reasons

Add a best-effort append to a new `candidate-scans` journal with one structured record per tick. Each record should include:

- cycle/tick timestamp
- strategy id
- raw candidate count
- post-safety candidate count
- post-LP-eligibility candidate count
- final selected candidate, if any
- blocked reason, if any
- per-candidate feature snapshots
- rejection metadata for safety and LP/bin eligibility

This data powers “filter too strict / too loose” evaluation without changing selection behavior.

### 2. Parameter snapshot evidence from live cycle

`src/runtime/live-cycle.ts` already records decision and execution artifacts. Add best-effort structured evidence only for research:

- the strategy parameter snapshot active for the cycle
- exit trigger evidence for TP/SL and LP/bin exits
- enough structured context to compare “actual exit” vs “alternate threshold would have held/closed”

This should not replace existing journals. It should add a lightweight research-focused event or journal entry that is easier to analyze offline than free-form audit text.

### 3. Watchlist follow-up from daemon/account state

`src/runtime/live-daemon.ts` already has access to account state and tick cadence. Add best-effort watchlist snapshot export for tracked tokens.

Tracked tokens should come from:

- selected candidates
- near-selected candidates that were blocked by filters
- tokens with wallet inventory
- tokens with LP positions

Each watchlist snapshot should capture follow-up state at later windows such as:

- `15m`
- `1h`
- `4h`
- `24h`

The design does not require exact scheduler precision. It requires durable follow-up windows with enough consistency to compare post-capture behavior across samples.

### 4. Optional SQLite mirror support

Extend the SQLite mirror with research-only tables for:

- `candidate_scans`
- `watchlist_snapshots`

This improves report speed and dashboard visibility, but it is still outside the trade-safety path. If the mirror is disabled or stale, report generation must still be able to fall back to JSONL artifacts.

## Research Data Model

### Candidate sample

Each `candidate_sample` records one candidate seen during one ingest tick.

Required fields:

- `sampleId`
- `capturedAt`
- `strategyId`
- `cycleId` or tick identifier
- `tokenMint`
- `tokenSymbol`
- `poolAddress`
- `liquidityUsd`
- `holders`
- `safetyScore`
- `volume24h`
- `feeTvlRatio24h`
- `binStep`
- `hasInventory`
- `hasLpPosition`
- `selected`
- `selectionRank`
- `blockedReason`
- `rejectionStage` such as `safety`, `lp_eligibility`, `selection`, or `none`
- `runtimeMode`
- `sessionPhase`

### Watchlist sample

Each `watchlist_sample` records the later observed behavior of a tracked token after it first entered the watchlist.

Required fields:

- `watchId`
- `trackedSince`
- `tokenMint`
- `tokenSymbol`
- `poolAddress`
- `observationAt`
- `windowLabel`
- `currentValueSol` or price proxy where available
- `liquidityUsd`
- `activeBinId`
- `lowerBinId`
- `upperBinId`
- `binCount`
- `fundedBinCount`
- `solDepletedBins`
- `unclaimedFeeSol`
- `hasInventory`
- `hasLpPosition`
- `sourceReason` such as `selected`, `filtered_out`, `wallet_inventory`, `lp_position`

### Position outcome sample

Each `position_outcome_sample` records the lifecycle of a real participated token.

Required fields:

- `positionId` or best equivalent composed id
- `tokenMint`
- `tokenSymbol`
- `openedAt`
- `closedAt`
- `entrySol`
- `maxObservedUpsidePct`
- `maxObservedDrawdownPct`
- `actualExitReason`
- `actualExitMetricValue`
- `takeProfitPctAtEntry`
- `stopLossPctAtEntry`
- `lpStopLossNetPnlPctAtEntry`
- `lpTakeProfitNetPnlPctAtEntry`
- `solDepletionExitBinsAtEntry`
- `minBinStepAtEntry`

### Evidence snapshot

Each report run persists an `evidence_snapshot` that freezes:

- time window
- sample counts
- strategy config path
- key regime labels
- headline diagnostics
- proposal ids tied to the evidence

This prevents later approvals from depending on mutable live data.

## Proposal Model

### Parameter proposals

Parameter proposals are the only proposals allowed to generate YAML patch drafts in Phase 1.

Allowed parameter paths:

- `filters.minLiquidityUsd`
- `riskThresholds.takeProfitPct`
- `riskThresholds.stopLossPct`
- `lpConfig.stopLossNetPnlPct`
- `lpConfig.takeProfitNetPnlPct`
- `lpConfig.solDepletionExitBins`
- `lpConfig.minBinStep`
- `lpConfig.minVolume24hUsd`
- `lpConfig.minFeeTvlRatio24h`

Each proposal must include:

- unique id
- target path
- old value
- proposed new value
- evidence window
- sample size
- rationale
- expected improvement metrics
- explicit risk note
- uncertainty note

Patch-draft constraints:

- no auto-apply
- no more than `1-3` closely related parameter changes per patch draft
- baseline check against the current YAML before approval artifacts are emitted
- stale proposals must fail closed if config drift is detected

### System proposals

System proposals are allowed for code-level ideas but cannot generate patch drafts in Phase 1.

Examples:

- adjust candidate ranking order
- change safety-score bonus formula
- refine watchlist admission logic

They exist so the report can surface non-config insights without giving the evolution layer code-writing authority.

## Analysis Rules

### Filter analysis

`filter-analysis.ts` should answer:

- how many candidates are blocked at each stage
- which blocked reasons dominate
- whether blocked candidates later outperform selected candidates on follow-through metrics
- whether chosen candidates systematically underperform after selection

This supports proposals around:

- `filters.minLiquidityUsd`
- LP eligibility thresholds
- fee/TVL and volume thresholds

Code-level selection weights can be diagnosed but not patched automatically in Phase 1.

### TP/SL analysis

`outcome-analysis.ts` should evaluate:

- how often take-profit exits are followed by continued upside
- how often stop-loss exits happen too late relative to later drawdown
- how often a modest threshold shift would have improved payoff without materially worsening drawdown

This supports proposals around:

- `riskThresholds.takeProfitPct`
- `riskThresholds.stopLossPct`
- `lpConfig.stopLossNetPnlPct`
- `lpConfig.takeProfitNetPnlPct`

### LP/bin analysis

The same analysis layer should evaluate:

- whether LP exits trigger before the token’s trend has clearly degraded
- whether `solDepletionExitBins` is consistently too early or too late
- whether `minBinStep` is excluding otherwise productive pools
- whether unclaimed-fee accumulation suggests different exit timing behavior

This supports proposals around:

- `lpConfig.solDepletionExitBins`
- `lpConfig.minBinStep`
- `lpConfig.minVolume24hUsd`
- `lpConfig.minFeeTvlRatio24h`

## Proposal Safety Rules

The evolution layer must emit explicit null outputs when evidence is insufficient.

Required no-action states:

- insufficient sample size
- conflicting evidence
- regime instability
- data coverage gaps
- no safe parameter proposal

This is important because the honest output is sometimes “keep observing.”

## Approval and Outcome Flow

### Report generation

`run-evolution-report-main.ts` should:

1. load candidate/watchlist/outcome evidence
2. compute diagnostics
3. generate markdown + JSON report artifacts
4. persist proposal catalog entries
5. emit YAML patch drafts only for parameter proposals that meet safety thresholds

### Approval

Approval records should be stored separately from the report body.

Each approval decision should record:

- proposal id
- action such as `approve`, `reject`, or `defer`
- note
- decision time
- related report path
- generated patch-draft path, if any

Approvals do not modify runtime config.

### Outcome review

Later report runs must be able to evaluate whether a human-applied parameter change was:

- `confirmed`
- `mixed`
- `rejected`
- `needs_more_data`

Outcome state should persist observed metrics and keep a durable audit history so the system can avoid repeating weak ideas as if they were new.

## Storage Layout

Store Phase 1 artifacts under a strategy-specific evolution root, for example:

- `state/evolution/new-token-v1/candidate-scans.jsonl`
- `state/evolution/new-token-v1/watchlist-snapshots.jsonl`
- `state/evolution/new-token-v1/evolution-report.md`
- `state/evolution/new-token-v1/evolution-report.json`
- `state/evolution/new-token-v1/proposal-catalog.json`
- `state/evolution/new-token-v1/approval-queue.json`
- `state/evolution/new-token-v1/approved-patches/<proposal-id>.yaml`
- `state/evolution/new-token-v1/approved-patches/<proposal-id>.meta.json`

The report generator should accept an override path, but the default should be deterministic and strategy-specific.

## Main-Path Isolation

This is the primary design constraint.

Rules:

- runtime evidence writes are best-effort only
- evolution write failures cannot alter cycle results
- report generation is a separate CLI path
- approval state is a separate offline state path
- no evolution logic is allowed inside live guards, runtime mode derivation, broadcaster/signing flow, or recovery policy

Forbidden areas for evolution-generated patches or automatic action:

- runtime mode policy
- pending-submission recovery
- reconciliation safety gates
- signer/quote/broadcast/account-provider contracts
- kill switch and live guard safety logic

## Error Handling

The research layer should degrade gracefully:

- if SQLite mirror is unavailable, read JSONL directly
- if watchlist follow-up is incomplete, mark coverage gaps and avoid strong proposals
- if evidence files are missing, emit no-action diagnostics instead of throwing away the whole report
- if baseline config has drifted, mark affected proposals stale and block patch-draft approval

Runtime integration points must never throw into the live cycle because of research storage issues.

## Validation

Add test coverage for:

- candidate sample serialization and append/read behavior
- watchlist snapshot serialization and follow-up window grouping
- filter diagnostics producing no-action vs actionable parameter proposals
- TP/SL analysis producing bounded proposals only when sample thresholds are met
- LP/bin analysis around `solDepletionExitBins` and `minBinStep`
- patch-draft generation with baseline drift detection
- approval queue persistence
- report generation from JSONL-only evidence
- report generation from SQLite-backed evidence
- runtime-side evidence append failures being swallowed without changing daemon or cycle outcomes

## Implementation Notes

This design intentionally does not copy `LightFee` module-for-module. The reusable pattern is:

- durable evidence
- offline diagnostics
- proposal catalog
- approval-gated patch drafting
- outcome tracking

The concrete implementation is adapted to `Lightld`’s existing strengths:

- structured runtime journals
- SQLite mirror
- token/LP strategy configuration
- long-running daemon with per-tick ingest

That keeps the system native to this repo instead of forcing an arbitrage-engine evolution model onto a token/LP runtime.
