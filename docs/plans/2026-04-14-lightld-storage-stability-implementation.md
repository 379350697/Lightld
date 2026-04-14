# Lightld Storage Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the long-running automation storage surfaces bounded and stable by adding journal retention/rotation, SQLite mirror retention, bounded in-memory cache cleanup, and housekeeping observability.

**Architecture:** Keep trading-path semantics unchanged. Add lightweight retention and cleanup around append-only journals, SQLite mirror tables/WAL, and long-lived in-memory caches. Cleanup must be best-effort, non-blocking, and visible in runtime health so unattended operation stays safe.

**Tech Stack:** Node.js, TypeScript, Vitest, JSONL journals, SQLite mirror, existing runtime state snapshots and health reporting.

---

### File Map

**Primary implementation files**
- Modify: `src/journals/jsonl-writer.ts`
- Modify: `src/journals/decision-audit-log.ts`
- Modify: `src/journals/quote-journal.ts`
- Modify: `src/journals/live-order-journal.ts`
- Modify: `src/journals/live-fill-journal.ts`
- Modify: `src/journals/live-incident-journal.ts`
- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/observability/mirror-config.ts`
- Modify: `src/observability/mirror-runtime.ts`
- Modify: `src/observability/sqlite-mirror-writer.ts`
- Modify: `src/ingest/gmgn/token-safety-client.ts`
- Modify: `src/runtime/health-report.ts`
- Modify: `src/runtime/state-types.ts`
- Modify: `src/cli/show-runtime-status.ts`
- Modify: `src/runtime/live-daemon.ts`
- Modify: `src/cli/run-live-daemon-main.ts`
- Modify: `docs/runbooks/long-running-live-runtime.md`
- Modify: `README.md`

**New support files**
- Create: `src/runtime/housekeeping.ts`
- Create: `tests/ts/runtime/housekeeping.test.ts`
- Create: `tests/ts/journals/jsonl-retention.test.ts`
- Create: `tests/ts/observability/sqlite-mirror-retention.test.ts`
- Create: `tests/ts/ingest/gmgn-token-safety-cache.test.ts`

---

### Task 1: Add JSONL Retention And Rotation

**Files:**
- Modify: `src/journals/jsonl-writer.ts`
- Modify: `src/journals/decision-audit-log.ts`
- Modify: `src/journals/quote-journal.ts`
- Modify: `src/journals/live-order-journal.ts`
- Modify: `src/journals/live-fill-journal.ts`
- Modify: `src/journals/live-incident-journal.ts`
- Test: `tests/ts/journals/jsonl-retention.test.ts`

- [ ] **Step 1: Write failing journal retention tests**

Cover:
- date-suffixed active file selection
- retention cleanup deletes old files only
- append still writes valid JSONL lines

- [ ] **Step 2: Run the journal retention test and verify it fails**

Run: `npm test -- --run tests/ts/journals/jsonl-retention.test.ts`

- [ ] **Step 3: Add date-aware path resolution and retention cleanup helpers in `jsonl-writer.ts`**

Implement:
- active filename suffix by UTC date
- cleanup helper that deletes files older than configured retention days
- non-destructive behavior when no retention config is supplied

- [ ] **Step 4: Thread retention-capable options into the journal wrappers**

Keep payload schema unchanged. Only change file naming and optional cleanup behavior.

- [ ] **Step 5: Run the journal retention test and impacted journal tests**

Run: `npm test -- --run tests/ts/journals/jsonl-retention.test.ts tests/ts/journals/live-order-journal.test.ts tests/ts/journals/live-fill-journal.test.ts tests/ts/journals/live-incident-journal.test.ts tests/ts/journals/quote-journal.test.ts tests/ts/journals/decision-audit-log.test.ts`

---

### Task 2: Make SQLite Mirror Retained And Self-Compacting

**Files:**
- Modify: `src/observability/mirror-config.ts`
- Modify: `src/observability/mirror-runtime.ts`
- Modify: `src/observability/sqlite-mirror-writer.ts`
- Test: `tests/ts/observability/sqlite-mirror-retention.test.ts`

- [ ] **Step 1: Write failing mirror retention tests**

Cover:
- pruning rows older than retention threshold
- WAL checkpoint invocation after prune
- no impact on recent rows

- [ ] **Step 2: Run the mirror retention test and verify it fails**

Run: `npm test -- --run tests/ts/observability/sqlite-mirror-retention.test.ts`

- [ ] **Step 3: Add retention config fields**

Add:
- `LIVE_DB_MIRROR_RETENTION_DAYS`
- `LIVE_DB_MIRROR_PRUNE_INTERVAL_MS`

- [ ] **Step 4: Add prune and checkpoint methods to `SqliteMirrorWriter`**

Implement:
- per-table delete by timestamp threshold
- WAL checkpoint truncate after prune
- returned metrics about deleted rows

- [ ] **Step 5: Run prune work from `mirror-runtime` on its own interval**

Constraint:
- must stay observability-only
- failures may degrade mirror state but must not block trading

- [ ] **Step 6: Run mirror retention and existing mirror tests**

Run: `npm test -- --run tests/ts/observability/sqlite-mirror-retention.test.ts tests/ts/observability/sqlite-mirror-writer.test.ts tests/ts/observability/mirror-runtime.test.ts tests/ts/observability/mirror-buffer.test.ts tests/ts/observability/mirror-catchup.test.ts`

---

### Task 3: Bound The GMGN Safety Cache

**Files:**
- Modify: `src/ingest/gmgn/token-safety-client.ts`
- Test: `tests/ts/ingest/gmgn-token-safety-cache.test.ts`

- [ ] **Step 1: Write failing cache tests**

Cover:
- expired entries get swept
- cache respects max entry count
- oldest entries are evicted when over limit

- [ ] **Step 2: Run the cache test and verify it fails**

Run: `npm test -- --run tests/ts/ingest/gmgn-token-safety-cache.test.ts`

- [ ] **Step 3: Add bounded cache cleanup**

Implement:
- TTL sweep
- `maxEntries` bound
- oldest-first eviction after expiry cleanup

- [ ] **Step 4: Keep fetch semantics unchanged**

Do not change:
- safety scoring
- subprocess contract
- current caller API

- [ ] **Step 5: Run the cache test and existing ingest tests**

Run: `npm test -- --run tests/ts/ingest/gmgn-token-safety-cache.test.ts tests/ts/runtime/ingest-context-builder.test.ts tests/ts/runtime/ingest-candidate-selection.test.ts`

---

### Task 4: Add Runtime Housekeeping

**Files:**
- Create: `src/runtime/housekeeping.ts`
- Modify: `src/runtime/live-daemon.ts`
- Test: `tests/ts/runtime/housekeeping.test.ts`

- [ ] **Step 1: Write failing housekeeping tests**

Cover:
- cleanup runs on interval
- failures are reported but do not throw through the trading loop
- return metrics summarize work done

- [ ] **Step 2: Run the housekeeping test and verify it fails**

Run: `npm test -- --run tests/ts/runtime/housekeeping.test.ts`

- [ ] **Step 3: Implement a best-effort housekeeping runner**

Responsibilities:
- trigger journal cleanup
- trigger mirror prune/checkpoint
- trigger GMGN cache sweep

- [ ] **Step 4: Integrate housekeeping into `runLiveDaemon`**

Constraint:
- no cleanup action may block order execution forever
- cleanup failures must degrade health, not crash the daemon

- [ ] **Step 5: Run housekeeping and daemon regression tests**

Run: `npm test -- --run tests/ts/runtime/housekeeping.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle-production.test.ts`

---

### Task 5: Expose Cleanup Health And Status

**Files:**
- Modify: `src/runtime/health-report.ts`
- Modify: `src/runtime/state-types.ts`
- Modify: `src/cli/show-runtime-status.ts`
- Modify: `src/runtime/live-daemon.ts`
- Test: `tests/ts/runtime/health-report.test.ts`
- Test: `tests/ts/cli/show-runtime-status.test.ts`

- [ ] **Step 1: Write failing health/status tests**

Cover:
- housekeeping timestamp visible
- deleted-file / deleted-row / cache-size counters visible
- status output remains compact

- [ ] **Step 2: Run the health/status tests and verify they fail**

Run: `npm test -- --run tests/ts/runtime/health-report.test.ts tests/ts/cli/show-runtime-status.test.ts`

- [ ] **Step 3: Extend health snapshots with housekeeping metrics**

Add fields for:
- `lastHousekeepingAt`
- `journalCleanupDeletedFiles`
- `mirrorPruneDeletedRows`
- `gmgnSafetyCacheEntries`
- `lastCleanupError`

- [ ] **Step 4: Update status rendering**

Keep output one-line and operator-friendly.

- [ ] **Step 5: Run health and status regression tests**

Run: `npm test -- --run tests/ts/runtime/health-report.test.ts tests/ts/cli/show-runtime-status.test.ts tests/ts/runtime/live-daemon.test.ts`

---

### Task 6: Wire Cleanup Config Into Runtime Entry Points

**Files:**
- Modify: `src/cli/run-live-daemon-main.ts`
- Modify: `src/observability/mirror-config.ts`
- Modify: `README.md`
- Modify: `docs/runbooks/long-running-live-runtime.md`

- [ ] **Step 1: Add runtime-facing environment parsing for cleanup settings**

Add only the minimum needed config:
- journal retention days by journal class
- mirror retention days
- mirror prune interval
- GMGN cache max entries

- [ ] **Step 2: Document bounded-storage defaults**

Update README and runbook with:
- recommended retention windows
- journald retention reminder
- explanation that snapshots remain single-file and bounded

- [ ] **Step 3: Run config and CLI regression tests**

Run: `npm test -- --run tests/ts/runtime/live-daemon.test.ts tests/ts/cli/show-runtime-status.test.ts tests/ts/config/loader.test.ts`

---

### Task 7: Full Verification

**Files:**
- Modify: `docs/plans/2026-04-14-lightld-storage-stability-implementation.md`

- [ ] **Step 1: Run targeted tests for the new cleanup surfaces**

Run:
- `npm test -- --run tests/ts/journals/jsonl-retention.test.ts`
- `npm test -- --run tests/ts/observability/sqlite-mirror-retention.test.ts`
- `npm test -- --run tests/ts/ingest/gmgn-token-safety-cache.test.ts`
- `npm test -- --run tests/ts/runtime/housekeeping.test.ts`

- [ ] **Step 2: Run full project verification**

Run:
- `npm run build`
- `npm test -- --run`

- [ ] **Step 3: Mark completed tasks and record effective defaults**

Update this plan with:
- final retention defaults
- any intentionally deferred cleanup work

---

### Deferred Follow-Up

This plan intentionally defers:
- further `live-cycle.ts` decomposition
- historical docs cleanup outside operator-facing README/runbook
- journal compression if retention alone is sufficient

Do those only after bounded-growth behavior is in production and verified.
