# New Token Evolution Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `new-token-v1`-only evolution research sidecar that collects candidate and watchlist evidence, analyzes filter and exit behavior, and emits approval-gated YAML patch drafts without changing the live trading path.

**Architecture:** Keep the live daemon authoritative for trading and safety. Add best-effort evidence capture at ingest/live-cycle/daemon boundaries, persist research artifacts under `state/evolution/new-token-v1/`, optionally mirror research rows into SQLite, and run all diagnostics, proposal generation, approval, and patch-draft generation through offline CLIs.

**Tech Stack:** TypeScript, Vitest, JSONL journals, SQLite mirror, existing CLI/runtime infrastructure

---

## File Structure

### Runtime and observability integration

- Modify: `src/runtime/ingest-context-builder.ts`
- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/runtime/live-daemon.ts`
- Modify: `src/runtime/housekeeping.ts`
- Modify: `src/runtime/state-types.ts`
- Modify: `src/observability/mirror-events.ts`
- Modify: `src/observability/mirror-adapters.ts`
- Modify: `src/observability/sqlite-mirror-schema.ts`
- Modify: `src/observability/sqlite-mirror-writer.ts`
- Modify: `src/observability/mirror-catchup.ts`
- Modify: `src/observability/mirror-query-service.ts`
- Modify: `src/dashboard/dashboard-server.ts`

### New evolution package

- Create: `src/evolution/types.ts`
- Create: `src/evolution/paths.ts`
- Create: `src/evolution/candidate-sample-store.ts`
- Create: `src/evolution/watchlist-store.ts`
- Create: `src/evolution/evidence-loader.ts`
- Create: `src/evolution/filter-analysis.ts`
- Create: `src/evolution/outcome-analysis.ts`
- Create: `src/evolution/proposal-engine.ts`
- Create: `src/evolution/patch-draft.ts`
- Create: `src/evolution/approval-store.ts`
- Create: `src/evolution/report-render.ts`
- Create: `src/evolution/index.ts`

### New CLI entrypoints

- Create: `src/cli/run-evolution-report.ts`
- Create: `src/cli/run-evolution-report-main.ts`
- Create: `src/cli/run-evolution-approval.ts`
- Create: `src/cli/run-evolution-approval-main.ts`
- Modify: `package.json`

### Tests

- Create: `tests/ts/evolution/candidate-sample-store.test.ts`
- Create: `tests/ts/evolution/watchlist-store.test.ts`
- Create: `tests/ts/evolution/filter-analysis.test.ts`
- Create: `tests/ts/evolution/outcome-analysis.test.ts`
- Create: `tests/ts/evolution/proposal-engine.test.ts`
- Create: `tests/ts/evolution/patch-draft.test.ts`
- Create: `tests/ts/evolution/approval-store.test.ts`
- Create: `tests/ts/evolution/report-render.test.ts`
- Create: `tests/ts/cli/run-evolution-report.test.ts`
- Create: `tests/ts/cli/run-evolution-approval.test.ts`
- Modify: `tests/ts/runtime/ingest-context-builder.test.ts`
- Modify: `tests/ts/runtime/live-cycle.test.ts`
- Modify: `tests/ts/runtime/live-daemon.test.ts`
- Modify: `tests/ts/observability/sqlite-mirror-writer.test.ts`
- Modify: `tests/ts/observability/mirror-catchup.test.ts`
- Modify: `tests/ts/observability/mirror-query-service.test.ts`

### Notes for implementers

- Keep all evolution-side writes best-effort only; swallow research persistence failures at runtime boundaries.
- Do not let any evolution result feed back into `runEngineCycle()`, `evaluateLiveGuards()`, runtime-mode derivation, or pending-submission recovery.
- Keep proposal scope limited to `new-token-v1` YAML parameters listed in the spec.

---

### Task 1: Scaffold the evolution package, path helpers, and storage primitives

**Files:**
- Create: `src/evolution/types.ts`
- Create: `src/evolution/paths.ts`
- Create: `src/evolution/candidate-sample-store.ts`
- Create: `src/evolution/watchlist-store.ts`
- Create: `src/evolution/index.ts`
- Create: `tests/ts/evolution/candidate-sample-store.test.ts`
- Create: `tests/ts/evolution/watchlist-store.test.ts`

- [ ] **Step 1: Write the failing storage tests**

Cover:
- default strategy-scoped evolution paths under `state/evolution/new-token-v1/`
- append/read behavior for candidate samples
- append/read behavior for watchlist snapshots
- graceful empty-state reads when files do not exist yet

Use compact fixtures that mirror the spec fields, for example:

```ts
const sample = {
  sampleId: 'cand-1',
  capturedAt: '2026-04-18T00:00:00.000Z',
  strategyId: 'new-token-v1',
  tokenMint: 'mint-safe',
  tokenSymbol: 'SAFE'
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ts/evolution/candidate-sample-store.test.ts tests/ts/evolution/watchlist-store.test.ts`
Expected: FAIL because the `src/evolution/` storage modules do not exist yet.

- [ ] **Step 3: Write the minimal storage implementation**

Implement:
- shared type definitions for candidate/watchlist/proposal/approval records
- path helpers for JSONL and JSON artifact locations
- JSONL-backed append/read stores using repo-standard file helpers
- an `index.ts` barrel only for stable public exports

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/ts/evolution/candidate-sample-store.test.ts tests/ts/evolution/watchlist-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/types.ts src/evolution/paths.ts src/evolution/candidate-sample-store.ts src/evolution/watchlist-store.ts src/evolution/index.ts tests/ts/evolution/candidate-sample-store.test.ts tests/ts/evolution/watchlist-store.test.ts
git commit -m "feat: scaffold evolution storage primitives"
```

### Task 2: Capture candidate scan evidence from ingest without changing selection behavior

**Files:**
- Modify: `src/runtime/ingest-context-builder.ts`
- Modify: `src/runtime/ingest-candidate-selection.ts`
- Modify: `tests/ts/runtime/ingest-context-builder.test.ts`
- Create: `tests/ts/evolution/filter-analysis.test.ts`

- [ ] **Step 1: Write the failing runtime evidence tests**

Add tests that expect `buildLiveCycleInputFromIngest()` to emit structured candidate-scan evidence that includes:
- raw candidate count
- post-safety and post-LP-eligibility counts
- selected candidate
- rejected candidates with rejection stage metadata

Inject a test double store or callback so the test can assert evidence content without relying on actual files.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ts/runtime/ingest-context-builder.test.ts`
Expected: FAIL because ingest currently returns only the selected context and does not emit candidate-scan evidence.

- [ ] **Step 3: Implement best-effort candidate evidence capture**

Add a narrow runtime-facing hook such as:

```ts
type CandidateScanSink = {
  appendScan(scan: CandidateScanRecord): Promise<void>;
};
```

Thread this through `buildLiveCycleInputFromIngest()` so the function can:
- assemble per-candidate snapshots
- tag rejection stages (`safety`, `lp_eligibility`, `selection`, `none`)
- append one scan record per tick

Wrap append calls in `try/catch` so failures do not alter the returned `IngestBackedCycleInput`.

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- tests/ts/runtime/ingest-context-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/ingest-context-builder.ts src/runtime/ingest-candidate-selection.ts tests/ts/runtime/ingest-context-builder.test.ts
git commit -m "feat: emit evolution candidate scan evidence"
```

### Task 3: Add live-cycle parameter snapshots and structured exit evidence

**Files:**
- Modify: `src/runtime/live-cycle.ts`
- Modify: `tests/ts/runtime/live-cycle.test.ts`
- Create: `tests/ts/evolution/outcome-analysis.test.ts`

- [ ] **Step 1: Write the failing live-cycle tests**

Cover:
- engine-stage evidence includes the active parameter snapshot for `new-token-v1`
- exit-related evidence captures TP/SL/LP/bin metrics when the cycle chooses an exit action
- research append failures do not change the cycle result

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ts/runtime/live-cycle.test.ts`
Expected: FAIL because the live cycle currently records only existing journals and mirror events.

- [ ] **Step 3: Implement structured research evidence append**

Add a research-only sink interface for live-cycle evidence and emit records that include:
- the active YAML-derived parameter snapshot
- actual exit reason and metric values
- LP-specific values such as `lpNetPnlPct`, `solDepletedBins`, `minBinStep`

Keep the hook optional and best-effort:

```ts
try {
  await evolutionSink?.appendOutcome(record);
} catch {
  // ignore research-only failure
}
```

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- tests/ts/runtime/live-cycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/live-cycle.ts tests/ts/runtime/live-cycle.test.ts
git commit -m "feat: add evolution live-cycle evidence"
```

### Task 4: Add watchlist tracking and follow-up snapshots in the daemon

**Files:**
- Modify: `src/runtime/live-daemon.ts`
- Modify: `src/runtime/state-types.ts`
- Modify: `src/runtime/housekeeping.ts`
- Modify: `tests/ts/runtime/live-daemon.test.ts`
- Create: `tests/ts/evolution/watchlist-store.test.ts`

- [ ] **Step 1: Write the failing daemon tests**

Add tests that expect the daemon to:
- admit tracked tokens from selected candidates, filtered candidates, wallet inventory, and LP positions
- emit best-effort watchlist snapshots with window labels
- keep running normally when watchlist persistence fails

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ts/runtime/live-daemon.test.ts`
Expected: FAIL because the daemon currently has no watchlist or evolution persistence flow.

- [ ] **Step 3: Implement watchlist maintenance hooks**

Add a small daemon-owned helper that:
- upserts tracked tokens into the evolution watchlist
- emits follow-up snapshots at durable windows such as `15m`, `1h`, `4h`, `24h`
- derives values from account state and the active cycle input when available

Keep scheduling lightweight; exact timers are not required as long as each window is emitted once when due.

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- tests/ts/runtime/live-daemon.test.ts tests/ts/evolution/watchlist-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/live-daemon.ts src/runtime/state-types.ts src/runtime/housekeeping.ts tests/ts/runtime/live-daemon.test.ts tests/ts/evolution/watchlist-store.test.ts
git commit -m "feat: track evolution watchlist snapshots"
```

### Task 5: Extend mirror events, SQLite schema, and catchup for research rows

**Files:**
- Modify: `src/observability/mirror-events.ts`
- Modify: `src/observability/mirror-adapters.ts`
- Modify: `src/observability/sqlite-mirror-schema.ts`
- Modify: `src/observability/sqlite-mirror-writer.ts`
- Modify: `src/observability/mirror-catchup.ts`
- Modify: `src/observability/mirror-query-service.ts`
- Modify: `tests/ts/observability/sqlite-mirror-writer.test.ts`
- Modify: `tests/ts/observability/mirror-catchup.test.ts`
- Modify: `tests/ts/observability/mirror-query-service.test.ts`

- [ ] **Step 1: Write the failing mirror tests**

Cover:
- new mirror event kinds for candidate scans and watchlist snapshots
- schema creation for `candidate_scans` and `watchlist_snapshots`
- batch writes and query reads for those tables
- catchup logic rehydrating research rows from JSONL into SQLite

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ts/observability/sqlite-mirror-writer.test.ts tests/ts/observability/mirror-catchup.test.ts tests/ts/observability/mirror-query-service.test.ts`
Expected: FAIL because the current mirror surface only knows cycle/order/fill/reconciliation/incident/runtime-snapshot rows.

- [ ] **Step 3: Implement research mirror support**

Add:
- mirror payload types for candidate scans and watchlist snapshots
- SQLite DDL plus any needed indexes
- writer support and light query helpers
- catchup support for the new JSONL journals

Do not change mirror semantics for existing hot-path tables.

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- tests/ts/observability/sqlite-mirror-writer.test.ts tests/ts/observability/mirror-catchup.test.ts tests/ts/observability/mirror-query-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/observability/mirror-events.ts src/observability/mirror-adapters.ts src/observability/sqlite-mirror-schema.ts src/observability/sqlite-mirror-writer.ts src/observability/mirror-catchup.ts src/observability/mirror-query-service.ts tests/ts/observability/sqlite-mirror-writer.test.ts tests/ts/observability/mirror-catchup.test.ts tests/ts/observability/mirror-query-service.test.ts
git commit -m "feat: mirror evolution research artifacts"
```

### Task 6: Build offline evidence loading plus filter and outcome analysis

**Files:**
- Create: `src/evolution/evidence-loader.ts`
- Create: `src/evolution/filter-analysis.ts`
- Create: `src/evolution/outcome-analysis.ts`
- Create: `tests/ts/evolution/filter-analysis.test.ts`
- Create: `tests/ts/evolution/outcome-analysis.test.ts`

- [ ] **Step 1: Write the failing analysis tests**

Cover:
- JSONL-only evidence loading fallback when SQLite is absent
- filter analysis surfacing blocked-reason concentration and missed-opportunity counts
- outcome analysis surfacing TP/SL too-early or too-late patterns
- LP/bin analysis surfacing `solDepletionExitBins` and `minBinStep` directional evidence
- explicit no-action results when sample counts are below threshold

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ts/evolution/filter-analysis.test.ts tests/ts/evolution/outcome-analysis.test.ts`
Expected: FAIL because no analysis modules exist yet.

- [ ] **Step 3: Implement bounded analysis logic**

Implement evidence loaders that can read from:
- SQLite mirror when available
- JSONL artifacts when mirror data is missing or disabled

Keep outputs deterministic and bounded. Return structured findings, not prose strings, for example:

```ts
type ParameterFinding = {
  path: string;
  direction: 'increase' | 'decrease' | 'hold';
  sampleSize: number;
  confidence: 'low' | 'medium' | 'high';
};
```

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- tests/ts/evolution/filter-analysis.test.ts tests/ts/evolution/outcome-analysis.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/evidence-loader.ts src/evolution/filter-analysis.ts src/evolution/outcome-analysis.ts tests/ts/evolution/filter-analysis.test.ts tests/ts/evolution/outcome-analysis.test.ts
git commit -m "feat: add evolution filter and outcome analysis"
```

### Task 7: Generate proposals, baseline-checked patch drafts, and approval state

**Files:**
- Create: `src/evolution/proposal-engine.ts`
- Create: `src/evolution/patch-draft.ts`
- Create: `src/evolution/approval-store.ts`
- Create: `tests/ts/evolution/proposal-engine.test.ts`
- Create: `tests/ts/evolution/patch-draft.test.ts`
- Create: `tests/ts/evolution/approval-store.test.ts`
- Modify: `src/config/strategies/new-token-v1.yaml`

- [ ] **Step 1: Write the failing proposal and patch tests**

Cover:
- parameter proposals only for the allowed YAML paths
- system proposals produced for code-level suggestions without patch drafts
- patch drafts changing at most `1-3` related parameters
- baseline drift detection against `src/config/strategies/new-token-v1.yaml`
- approval queue persistence with `approve`, `reject`, `defer`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ts/evolution/proposal-engine.test.ts tests/ts/evolution/patch-draft.test.ts tests/ts/evolution/approval-store.test.ts`
Expected: FAIL because proposal and approval modules do not exist yet.

- [ ] **Step 3: Implement proposal safety rules**

Implement:
- an allowlist for patchable paths
- explicit null outputs like `no_safe_parameter_proposal`
- grouped patch-draft generation in YAML form
- metadata JSON with evidence window, sample counts, and risk notes
- approval queue storage that never edits the live config

Use the checked-in `new-token-v1.yaml` as the baseline target for draft generation but do not modify it during report generation.

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- tests/ts/evolution/proposal-engine.test.ts tests/ts/evolution/patch-draft.test.ts tests/ts/evolution/approval-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/proposal-engine.ts src/evolution/patch-draft.ts src/evolution/approval-store.ts tests/ts/evolution/proposal-engine.test.ts tests/ts/evolution/patch-draft.test.ts tests/ts/evolution/approval-store.test.ts
git commit -m "feat: add evolution proposals and patch drafts"
```

### Task 8: Render reports and expose offline report/approval CLIs

**Files:**
- Create: `src/evolution/report-render.ts`
- Create: `src/cli/run-evolution-report.ts`
- Create: `src/cli/run-evolution-report-main.ts`
- Create: `src/cli/run-evolution-approval.ts`
- Create: `src/cli/run-evolution-approval-main.ts`
- Modify: `package.json`
- Create: `tests/ts/evolution/report-render.test.ts`
- Create: `tests/ts/cli/run-evolution-report.test.ts`
- Create: `tests/ts/cli/run-evolution-approval.test.ts`

- [ ] **Step 1: Write the failing CLI and rendering tests**

Cover:
- markdown and JSON report artifact generation
- default output root under `state/evolution/new-token-v1/`
- report CLI argument parsing
- approval CLI argument parsing and queue mutation
- no-action report output when evidence is thin

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ts/evolution/report-render.test.ts tests/ts/cli/run-evolution-report.test.ts tests/ts/cli/run-evolution-approval.test.ts`
Expected: FAIL because no renderer or evolution CLIs exist yet.

- [ ] **Step 3: Implement the offline command surface**

Add CLI commands similar to existing repo patterns:

```ts
runEvolutionReport({
  strategy: 'new-token-v1',
  outputDir,
  sinceHours: 24
});
```

Update `package.json` scripts with stable entrypoints, for example:
- `run:evolution-report`
- `run:evolution-approval`

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- tests/ts/evolution/report-render.test.ts tests/ts/cli/run-evolution-report.test.ts tests/ts/cli/run-evolution-approval.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/report-render.ts src/cli/run-evolution-report.ts src/cli/run-evolution-report-main.ts src/cli/run-evolution-approval.ts src/cli/run-evolution-approval-main.ts package.json tests/ts/evolution/report-render.test.ts tests/ts/cli/run-evolution-report.test.ts tests/ts/cli/run-evolution-approval.test.ts
git commit -m "feat: add evolution report and approval clis"
```

### Task 9: Surface research visibility in dashboard/status and verify end-to-end isolation

**Files:**
- Modify: `src/dashboard/dashboard-server.ts`
- Modify: `src/cli/show-runtime-status.ts`
- Modify: `src/cli/show-runtime-status-main.ts`
- Modify: `tests/ts/cli/show-runtime-status.test.ts`
- Modify: `tests/ts/runtime/live-daemon.test.ts`
- Modify: `tests/ts/runtime/live-cycle.test.ts`

- [ ] **Step 1: Write the failing visibility/regression tests**

Cover:
- dashboard/status readers can show recent research counts or recent proposal summaries when present
- evolution artifacts remain optional and do not break status output when absent
- runtime still succeeds when research storage throws during ingest, live-cycle, or watchlist append

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ts/cli/show-runtime-status.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle.test.ts`
Expected: FAIL on the new evolution visibility and failure-isolation assertions.

- [ ] **Step 3: Implement read-only visibility hooks**

Keep this lightweight:
- add recent research summary fields only where they fit existing status/dashboard patterns
- do not add any new dashboard dependency on evolution data being present

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- tests/ts/cli/show-runtime-status.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/dashboard-server.ts src/cli/show-runtime-status.ts src/cli/show-runtime-status-main.ts tests/ts/cli/show-runtime-status.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle.test.ts
git commit -m "feat: expose evolution research visibility"
```

### Task 10: Run final verification for the whole vertical slice

**Files:**
- Test: `tests/ts/evolution/*.test.ts`
- Test: `tests/ts/runtime/ingest-context-builder.test.ts`
- Test: `tests/ts/runtime/live-cycle.test.ts`
- Test: `tests/ts/runtime/live-daemon.test.ts`
- Test: `tests/ts/observability/sqlite-mirror-writer.test.ts`
- Test: `tests/ts/observability/mirror-catchup.test.ts`
- Test: `tests/ts/observability/mirror-query-service.test.ts`
- Test: `tests/ts/cli/run-evolution-report.test.ts`
- Test: `tests/ts/cli/run-evolution-approval.test.ts`
- Test: `tests/ts/cli/show-runtime-status.test.ts`
- Test: `npm run build`

- [ ] **Step 1: Run the evolution-focused test suite**

Run:

```bash
npm test -- tests/ts/evolution/candidate-sample-store.test.ts tests/ts/evolution/watchlist-store.test.ts tests/ts/evolution/filter-analysis.test.ts tests/ts/evolution/outcome-analysis.test.ts tests/ts/evolution/proposal-engine.test.ts tests/ts/evolution/patch-draft.test.ts tests/ts/evolution/approval-store.test.ts tests/ts/evolution/report-render.test.ts tests/ts/cli/run-evolution-report.test.ts tests/ts/cli/run-evolution-approval.test.ts
```

Expected: PASS

- [ ] **Step 2: Run runtime and observability regressions**

Run:

```bash
npm test -- tests/ts/runtime/ingest-context-builder.test.ts tests/ts/runtime/live-cycle.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/observability/sqlite-mirror-writer.test.ts tests/ts/observability/mirror-catchup.test.ts tests/ts/observability/mirror-query-service.test.ts tests/ts/cli/show-runtime-status.test.ts
```

Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Record final outcome**

Document that:
- the runtime now emits research evidence without giving evolution any hot-path control
- the offline evolution layer can analyze `new-token-v1` filter and exit behavior
- reports and approval-gated YAML patch drafts are available under the evolution state root

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-04-18-new-token-evolution-research.md
git commit -m "docs: add new-token evolution implementation plan"
```
