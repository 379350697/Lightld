# Lightweight DB Mirror Observability Design

## Context

The current project already has a Linux-first single-process live runtime with:

- file-backed runtime snapshots under `state/`
- append-only JSONL journals under `tmp/journals/`
- recovery gating for unresolved submissions
- independent confirmation polling
- token-aware reconciliation

That is a good safety base for unattended live trading, but long-running single-user operation still has two weak spots:

1. operator visibility becomes increasingly expensive because most history must be read from JSONL
2. long-term troubleshooting, aggregation, and lightweight reporting are limited by the lack of a structured query layer

The new requirement is not to replace the current truth sources. It is to add a lightweight persistence and query layer that improves reliability and observability without ever becoming part of the trade-critical path.

## Goals

- Keep the current trade-critical truth sources unchanged:
  - in-memory cycle state
  - atomic `state/*.json`
  - append-only JSONL journals
- Add a lightweight database that mirrors runtime and journal facts for faster queries.
- Preserve unattended stability by ensuring database slowdowns or failures do not block trading.
- Improve performance for status inspection, incident search, reconciliation review, and order-history lookup.
- Keep logging comprehensive while avoiding high write amplification.

## Non-Goals

- No migration of execution safety decisions onto the database.
- No replacement of JSONL journals with a database-only design.
- No external database service, Redis, or message queue.
- No heavy analytics warehouse or dashboard platform.
- No changes to strategy, trading logic, or main execution sequencing.

## Approaches Considered

### 1. File-only enhancement

Improve file naming, rotation, and indexing while keeping everything in JSONL and JSON snapshots.

Pros:

- smallest operational footprint
- minimal implementation risk
- no extra write target

Cons:

- weak query ergonomics
- expensive aggregation over long time windows
- limited unattended diagnostics

### 2. Hybrid mirror with SQLite

Preserve files as the source of truth, and add an asynchronous SQLite mirror used for structured lookup and lightweight historical analysis.

Pros:

- keeps trading safety tied to existing truth sources
- materially improves operator visibility
- works well on one Linux host
- low resource usage with WAL and single-writer batching

Cons:

- adds a background buffering and retry layer
- needs careful degradation logic so mirror failures stay isolated

### 3. Database-first runtime

Move most runtime state and logging into SQLite and use files mainly as exports or backups.

Pros:

- unified query model
- simpler downstream reporting

Cons:

- higher coupling between runtime health and database health
- greater risk of blocking or lock contention impacting trading behavior
- not aligned with the requirement that the database must not affect the main path

## Chosen Approach

The chosen design is **hybrid mirror with SQLite**.

The runtime keeps its current file-first safety model. JSON snapshots and JSONL journals remain the authoritative persistent record for runtime recovery and audit. A lightweight SQLite database is introduced as an asynchronous mirror that stores structured summaries and indexed references for fast lookup.

The mirror path is intentionally second-class relative to trading:

- mirror writes happen after the current file writes
- mirror writes are buffered in memory and flushed in the background
- mirror failures degrade only the observability layer, not the trade path

## Core Principles

- **Files remain the truth source.**
- **The main trade path never waits for SQL.**
- **Database failures are isolated and degradable.**
- **Critical audit facts are still written to JSONL first.**
- **The mirror stores structured query data, not every raw byte of every journal line.**

## Runtime Architecture

The design adds a new observability subsystem inside the existing single process:

- `db-mirror-buffer`
  accepts structured mirror events from the runtime and journals
- `db-mirror-writer`
  drains the buffer in small batches and writes to SQLite in one transaction per batch
- `db-mirror-state`
  tracks queue depth, write latency, consecutive failures, dropped events, and circuit state
- `db-query-surface`
  serves status and historical lookup paths using SQLite when available, with fallback to file-based state

The existing runtime state and journal writers remain unchanged as the primary persistence path.

## Main Data Flow

Each cycle follows this sequence:

1. Run the existing live cycle.
2. Persist primary runtime snapshots and JSONL journals exactly as today.
3. Build one or more structured mirror events from those already-known facts.
4. Push mirror events into a bounded in-memory queue.
5. Return control to the runtime without waiting for database completion.
6. A background mirror writer flushes queued events to SQLite in small transactions.
7. Status and operator tooling read from SQLite when healthy, otherwise fall back to file-backed state.

This keeps the trade path independent from database latency while still giving the operator a queryable history.

## Storage Model

### Primary truth sources

- `state/runtime-state.json`
- `state/dependency-health.json`
- `state/pending-submission.json`
- `state/position-state.json`
- `state/health.json`
- `tmp/journals/*.jsonl`

### Secondary mirror store

- one local SQLite file, for example `state/lightld-observability.sqlite`

SQLite is configured for a single-process single-writer pattern:

- `WAL` mode
- moderate `busy_timeout`
- `synchronous=NORMAL`
- small batch writes

Because SQLite is not the recovery truth source, these settings are acceptable and keep the write cost low.

## Mirror Schema

The first version should remain intentionally small.

### `cycle_runs`

One row per daemon tick.

Key columns:

- `cycle_id`
- `strategy_id`
- `started_at`
- `finished_at`
- `runtime_mode`
- `session_phase`
- `action`
- `result_mode`
- `reason`
- `pool_address`
- `token_mint`
- `token_symbol`
- `requested_position_sol`
- `quote_collected`
- `live_order_submitted`
- `confirmation_status`
- `reconciliation_ok`
- `duration_ms`

### `orders`

One row per order lifecycle record.

Key columns:

- `idempotency_key`
- `cycle_id`
- `strategy_id`
- `submission_id`
- `confirmation_signature`
- `pool_address`
- `token_mint`
- `token_symbol`
- `action`
- `requested_position_sol`
- `quoted_output_sol`
- `broadcast_status`
- `confirmation_status`
- `finality`
- `created_at`
- `updated_at`

### `fills`

One row per fill or fill-derived confirmation fact.

Key columns:

- `fill_id`
- `submission_id`
- `confirmation_signature`
- `cycle_id`
- `token_mint`
- `token_symbol`
- `side`
- `amount`
- `filled_sol`
- `recorded_at`

### `reconciliations`

One row per reconciliation summary.

Key columns:

- `cycle_id`
- `wallet_sol`
- `journal_sol`
- `delta_sol`
- `token_delta_count`
- `ok`
- `reason`
- `recorded_at`
- `raw_json`

### `incidents`

One row per warning or error event that matters operationally.

Key columns:

- `incident_id`
- `cycle_id`
- `stage`
- `severity`
- `reason`
- `runtime_mode`
- `submission_id`
- `token_mint`
- `token_symbol`
- `recorded_at`

### `runtime_snapshots`

One row per runtime state mirror.

Key columns:

- `snapshot_at`
- `runtime_mode`
- `allow_new_opens`
- `flatten_only`
- `pending_submission`
- `circuit_reason`
- `quote_failures`
- `reconcile_failures`

## Mirror Event Priority

To keep the system lightweight under stress, mirror events should be prioritized:

### High priority

- orders
- fills
- incidents
- runtime snapshots

### Medium priority

- cycle summaries
- reconciliation summaries

### Low priority

- quote summaries
- optional context summaries

If the mirror queue comes under pressure, low-priority events may be dropped from the database mirror while still being fully preserved in JSONL.

## Degradation Model

The mirror subsystem has its own independent health state:

- `healthy`
- `degraded`
- `open`

Behavior:

- short transient write failures trigger bounded retry
- repeated failures open the mirror circuit
- while open, new mirror writes are skipped or buffered only up to a safe queue limit
- after cooldown, a lightweight probe write attempts recovery

The important rule is:

- **mirror degradation does not stop trading**

Instead, it:

- records an incident in the primary journals
- updates health output to show the observability layer is degraded
- reduces query fidelity until recovery succeeds

## Queueing And Backpressure

The mirror queue must be bounded.

Recommended initial behavior:

- queue size cap around `1000` events
- flush interval around `250ms`
- batch size around `32` to `128`
- single-writer background loop only

If the queue is full:

- keep high-priority events whenever possible
- drop lower-priority mirror events first
- increment a dropped-event counter
- emit a throttled incident so the operator knows query completeness is degraded

This preserves process stability under stress.

## Logging Model

The project should keep a three-layer logging model:

### 1. Audit layer

Current JSONL journals remain the full append-only audit log.

### 2. Query layer

SQLite stores structured summaries and indexed references for fast lookup.

### 3. Performance layer

Per-stage timing summaries are recorded for:

- ingest
- quote
- sign
- broadcast
- confirm
- reconcile
- db mirror flush

This makes it possible to detect long-running latency regressions without introducing high-cardinality telemetry infrastructure.

## Performance Notes

The design should optimize for low operator latency, not lower trading latency.

The main benefits are:

- faster status queries
- cheaper incident search
- faster order lookup by `submissionId` or `idempotencyKey`
- easier long-window analysis of confirmation and reconciliation behavior

To keep write cost low:

- use a single SQLite connection for writes
- use batched transactions
- avoid over-indexing
- store only structured summaries and small `raw_json` blobs where they provide clear value

## Status And Operator Surfaces

The status CLI should gain optional database-backed paths:

- recent incidents
- recent order states
- mirror health
- queue depth
- dropped event count

If SQLite is unavailable, the CLI should fall back to the current file-backed view without breaking operator access.

## Testing Strategy

The implementation should be verified with:

- unit tests for mirror queue ordering and priority dropping
- unit tests for SQLite schema init and batched writes
- unit tests for mirror degradation and recovery behavior
- runtime tests proving mirror failures do not block `runLiveCycle`
- daemon tests proving health output reflects mirror degradation
- CLI tests proving fallback to file-backed status when the mirror is unavailable

## Acceptance Criteria

- Trading still succeeds when the database mirror is disabled or unhealthy.
- JSON snapshots and JSONL journals remain complete enough for recovery and audit.
- SQLite contains queryable cycle, order, fill, incident, reconciliation, and runtime summary data.
- The mirror path retries transient write failures and then degrades without blocking the main path.
- Mirror queue pressure is bounded and visible through health output or incidents.
- The operator can inspect recent history faster through SQLite-backed status surfaces.

## Notes

- The current workspace root is not a git repository, so the design can be saved locally but cannot be committed yet.
- The design intentionally optimizes for single-user unattended Linux operation rather than multi-user analytics.
