# Lightweight DB Mirror Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a lightweight SQLite observability mirror that improves unattended queryability and operational visibility without ever blocking the trading main path.

**Architecture:** Keep `state/*.json` and JSONL journals as the primary truth sources. Introduce a bounded in-memory mirror queue and a single-writer SQLite background flusher that mirrors structured runtime events asynchronously. If the mirror becomes unhealthy, degrade the mirror path only and keep trading live.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Zod, JSONL journals, atomic JSON state snapshots, SQLite in WAL mode, Linux `systemd`

---

### Task 1: Mirror Config And Health Types

**Files:**
- Create: `src/observability/mirror-types.ts`
- Create: `src/observability/mirror-config.ts`
- Modify: `src/runtime/state-types.ts`
- Test: `tests/ts/observability/mirror-config.test.ts`
- Test: `tests/ts/observability/mirror-types.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { loadMirrorConfig } from '../../../src/observability/mirror-config';

describe('loadMirrorConfig', () => {
  it('loads an enabled sqlite mirror config', () => {
    expect(loadMirrorConfig({
      LIVE_DB_MIRROR_ENABLED: 'true',
      LIVE_DB_MIRROR_PATH: '/tmp/lightld.sqlite'
    })).toMatchObject({
      enabled: true,
      path: '/tmp/lightld.sqlite'
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/observability/mirror-config.test.ts tests/ts/observability/mirror-types.test.ts`
Expected: FAIL because the mirror config and type modules do not exist.

**Step 3: Write minimal implementation**

Create typed definitions for:

- mirror health state: `healthy | degraded | open`
- mirror event priority: `high | medium | low`
- mirror queue metrics
- mirror config with:
  - enabled flag
  - sqlite path
  - queue size limit
  - batch size
  - flush interval ms
  - retry count
  - cooldown ms

Also extend runtime health/state types so health output can include mirror health summary without making it required for recovery logic.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/observability/mirror-config.test.ts tests/ts/observability/mirror-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/observability/mirror-types.ts src/observability/mirror-config.ts src/runtime/state-types.ts tests/ts/observability/mirror-config.test.ts tests/ts/observability/mirror-types.test.ts
git commit -m "feat: add mirror config and health types"
```

### Task 2: Mirror Event Model And Bounded Buffer

**Files:**
- Create: `src/observability/mirror-events.ts`
- Create: `src/observability/mirror-buffer.ts`
- Test: `tests/ts/observability/mirror-buffer.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { MirrorBuffer } from '../../../src/observability/mirror-buffer';

describe('MirrorBuffer', () => {
  it('drops low priority events before high priority events when full', () => {
    const buffer = new MirrorBuffer({ capacity: 2 });

    buffer.enqueue({ type: 'cycle', priority: 'low', payload: { cycleId: 'c1' } });
    buffer.enqueue({ type: 'incident', priority: 'high', payload: { cycleId: 'c2' } });
    buffer.enqueue({ type: 'order', priority: 'high', payload: { cycleId: 'c3' } });

    expect(buffer.snapshot().droppedLowPriority).toBe(1);
    expect(buffer.drain(10).map((event) => event.type)).toEqual(['incident', 'order']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/observability/mirror-buffer.test.ts`
Expected: FAIL because the buffer module does not exist.

**Step 3: Write minimal implementation**

Create:

- a mirror event union for:
  - cycle summary
  - order summary
  - fill summary
  - reconciliation summary
  - incident summary
  - runtime snapshot
- a bounded buffer that:
  - enqueues events
  - drains events in insertion order
  - tracks dropped counts
  - preferentially drops low-priority events under pressure

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/observability/mirror-buffer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/observability/mirror-events.ts src/observability/mirror-buffer.ts tests/ts/observability/mirror-buffer.test.ts
git commit -m "feat: add bounded mirror buffer"
```

### Task 3: SQLite Schema And Mirror Writer

**Files:**
- Create: `src/observability/sqlite-mirror-schema.ts`
- Create: `src/observability/sqlite-mirror-writer.ts`
- Test: `tests/ts/observability/sqlite-mirror-writer.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteMirrorWriter } from '../../../src/observability/sqlite-mirror-writer';

describe('SqliteMirrorWriter', () => {
  it('initializes schema and writes a batch of mirror events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-mirror-'));
    const writer = new SqliteMirrorWriter({ path: join(root, 'mirror.sqlite') });

    await writer.open();
    await writer.writeBatch([
      { type: 'runtime_snapshot', priority: 'high', payload: { snapshotAt: '2026-03-22T00:00:00.000Z', runtimeMode: 'healthy', allowNewOpens: true, flattenOnly: false, pendingSubmission: false, circuitReason: '', quoteFailures: 0, reconcileFailures: 0 } }
    ]);

    await expect(writer.countRows('runtime_snapshots')).resolves.toBe(1);
    await writer.close();
    await rm(root, { recursive: true, force: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/observability/sqlite-mirror-writer.test.ts`
Expected: FAIL because the SQLite writer does not exist.

**Step 3: Write minimal implementation**

Create:

- schema bootstrap SQL for:
  - `cycle_runs`
  - `orders`
  - `fills`
  - `reconciliations`
  - `incidents`
  - `runtime_snapshots`
- a single-writer SQLite wrapper that:
  - opens the database
  - enables WAL mode
  - writes batches in one transaction
  - exposes minimal test helpers

Keep schema compact and add only the indexes needed for likely operator queries.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/observability/sqlite-mirror-writer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/observability/sqlite-mirror-schema.ts src/observability/sqlite-mirror-writer.ts tests/ts/observability/sqlite-mirror-writer.test.ts
git commit -m "feat: add sqlite mirror schema and writer"
```

### Task 4: Mirror Runtime Loop With Retry And Degradation

**Files:**
- Create: `src/observability/mirror-runtime.ts`
- Test: `tests/ts/observability/mirror-runtime.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createMirrorRuntime } from '../../../src/observability/mirror-runtime';

describe('createMirrorRuntime', () => {
  it('opens the mirror circuit after repeated writer failures without throwing to the caller', async () => {
    let writes = 0;
    const runtime = createMirrorRuntime({
      config: { enabled: true, path: '/tmp/test.sqlite', queueCapacity: 10, batchSize: 2, flushIntervalMs: 10, maxRetries: 1, cooldownMs: 1000 },
      writer: {
        open: async () => {},
        close: async () => {},
        writeBatch: async () => {
          writes += 1;
          throw new Error('db locked');
        }
      }
    });

    runtime.enqueue({ type: 'incident', priority: 'high', payload: { cycleId: 'c1', stage: 'mirror', severity: 'warning', reason: 'test', runtimeMode: 'healthy', recordedAt: '2026-03-22T00:00:00.000Z' } });
    await runtime.flushOnce();
    await runtime.flushOnce();

    expect(writes).toBeGreaterThan(0);
    expect(runtime.snapshot().health).toBe('open');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/observability/mirror-runtime.test.ts`
Expected: FAIL because the mirror runtime does not exist.

**Step 3: Write minimal implementation**

Create a runtime coordinator that:

- holds the buffer
- calls the SQLite writer
- retries transient failures a bounded number of times
- opens the mirror circuit after repeated failures
- tracks:
  - queue depth
  - dropped events
  - consecutive failures
  - last flush latency
  - last success time

Do not throw mirror write failures back into the trading path.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/observability/mirror-runtime.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/observability/mirror-runtime.ts tests/ts/observability/mirror-runtime.test.ts
git commit -m "feat: add resilient mirror runtime"
```

### Task 5: Mirror Adapters For Runtime And Journal Facts

**Files:**
- Create: `src/observability/mirror-adapters.ts`
- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/runtime/live-daemon.ts`
- Modify: `src/runtime/runtime-state-store.ts`
- Test: `tests/ts/observability/mirror-adapters.test.ts`
- Test: `tests/ts/runtime/live-daemon.test.ts`
- Test: `tests/ts/runtime/live-cycle.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { toRuntimeSnapshotEvent } from '../../../src/observability/mirror-adapters';

describe('toRuntimeSnapshotEvent', () => {
  it('builds a high-priority mirror event from health report data', () => {
    expect(toRuntimeSnapshotEvent({
      mode: 'healthy',
      allowNewOpens: true,
      flattenOnly: false,
      pendingSubmission: false,
      circuitReason: '',
      lastSuccessfulTickAt: '2026-03-22T00:00:00.000Z',
      dependencyHealth: { quoteFailures: 0, reconcileFailures: 0 },
      updatedAt: '2026-03-22T00:00:00.000Z'
    })).toMatchObject({
      type: 'runtime_snapshot',
      priority: 'high'
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/observability/mirror-adapters.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle.test.ts`
Expected: FAIL because mirror adapters and runtime integration do not exist.

**Step 3: Write minimal implementation**

Create adapter functions that turn existing facts into mirror events:

- runtime health report -> runtime snapshot event
- live cycle result -> cycle summary event
- order submission -> order event
- fill journal write -> fill event
- reconciliation result -> reconciliation event
- incident append -> incident event

Then integrate mirror event emission into:

- `runLiveCycle`
- `runLiveDaemon`

The integration must:

- emit mirror events after primary file writes
- never await SQLite work from inside the trade-critical path
- remain a no-op when mirror config is disabled

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/observability/mirror-adapters.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/observability/mirror-adapters.ts src/runtime/live-cycle.ts src/runtime/live-daemon.ts src/runtime/runtime-state-store.ts tests/ts/observability/mirror-adapters.test.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/live-cycle.test.ts
git commit -m "feat: mirror runtime and journal facts to sqlite"
```

### Task 6: Status Query Surface And File Fallback

**Files:**
- Create: `src/observability/mirror-query-service.ts`
- Modify: `src/cli/show-runtime-status-main.ts`
- Test: `tests/ts/observability/mirror-query-service.test.ts`
- Test: `tests/ts/cli/show-runtime-status.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildStatusView } from '../../../src/observability/mirror-query-service';

describe('buildStatusView', () => {
  it('falls back to file-backed state when the mirror is unavailable', async () => {
    const result = await buildStatusView({
      mirrorQuery: async () => {
        throw new Error('mirror unavailable');
      },
      fileState: async () => ({
        mode: 'healthy',
        pendingSubmission: false
      })
    });

    expect(result.mode).toBe('healthy');
    expect(result.pendingSubmission).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/observability/mirror-query-service.test.ts tests/ts/cli/show-runtime-status.test.ts`
Expected: FAIL because the query service does not exist.

**Step 3: Write minimal implementation**

Create a query service that:

- reads recent incidents, orders, and mirror health from SQLite when available
- falls back to current file-backed runtime state and health snapshots on mirror failure

Update the status CLI to show:

- mirror health
- mirror queue depth
- dropped mirror events
- recent incidents if available

Do not remove the current file-based status behavior.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/observability/mirror-query-service.test.ts tests/ts/cli/show-runtime-status.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/observability/mirror-query-service.ts src/cli/show-runtime-status-main.ts tests/ts/observability/mirror-query-service.test.ts tests/ts/cli/show-runtime-status.test.ts
git commit -m "feat: add mirror-backed status queries"
```

### Task 7: Mirror Catch-Up And Journal Cursor

**Files:**
- Create: `src/observability/mirror-catchup.ts`
- Create: `src/observability/mirror-cursor-store.ts`
- Test: `tests/ts/observability/mirror-catchup.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { applyCatchupWindow } from '../../../src/observability/mirror-catchup';

describe('applyCatchupWindow', () => {
  it('returns only unseen journal records after the stored cursor', () => {
    const result = applyCatchupWindow({
      lines: [
        { offset: 1, value: { cycleId: 'c1' } },
        { offset: 2, value: { cycleId: 'c2' } }
      ],
      lastOffset: 1
    });

    expect(result.map((entry) => entry.offset)).toEqual([2]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/observability/mirror-catchup.test.ts`
Expected: FAIL because catch-up helpers do not exist.

**Step 3: Write minimal implementation**

Create a catch-up helper that:

- tracks per-journal cursors in a lightweight file-backed cursor store
- can replay missing JSONL records into mirror events at low priority
- only runs when the mirror is healthy and the live queue is not under pressure

Keep catch-up optional and conservative.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/observability/mirror-catchup.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/observability/mirror-catchup.ts src/observability/mirror-cursor-store.ts tests/ts/observability/mirror-catchup.test.ts
git commit -m "feat: add mirror catch-up support"
```

### Task 8: Linux Operator Docs And Config Surface

**Files:**
- Modify: `README.md`
- Modify: `docs/runbooks/long-running-live-runtime.md`
- Modify: `ops/systemd/lightld.service`

**Step 1: Write the operator-facing docs changes**

Document:

- new `LIVE_DB_MIRROR_*` environment variables
- default mirror-off behavior
- queue, retry, and degradation policy
- SQLite path recommendations on Linux
- how to inspect mirror health from the status CLI
- how to safely disable the mirror without affecting trading

**Step 2: Run documentation sanity review**

Run: `Get-Content README.md`
Expected: clear Linux-first instructions and explicit statement that the mirror does not gate trades.

**Step 3: Update service notes**

Document recommended storage paths such as:

- `/opt/lightld/state`
- `/opt/lightld/tmp/journals`
- `/opt/lightld/state/lightld-observability.sqlite`

**Step 4: Verify docs match actual CLI behavior**

Run: `npm test -- tests/ts/cli/show-runtime-status.test.ts tests/ts/runtime/live-daemon.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add README.md docs/runbooks/long-running-live-runtime.md ops/systemd/lightld.service
git commit -m "docs: add sqlite mirror ops guidance"
```

### Task 9: Full Verification And Failure Drill

**Files:**
- Verify: `tests/ts/**`
- Modify: `README.md`

**Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS across runtime, execution, observability, CLI, and journal tests.

**Step 2: Run the TypeScript compiler**

Run: `npm run build`
Expected: PASS with no type errors.

**Step 3: Run a failure drill**

Simulate:

- SQLite writer failure
- queue pressure
- status CLI fallback

Expected:

- trading path continues
- mirror health opens independently
- recent state remains available from file-backed snapshots

**Step 4: Review acceptance criteria**

Confirm the implementation supports:

- single-process Linux operation
- bounded mirror buffering
- database degradation without trade blockage
- faster query paths for orders, incidents, and runtime snapshots

**Step 5: Commit**

```bash
git add README.md
git commit -m "chore: finalize sqlite mirror observability verification"
```
