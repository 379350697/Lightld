# Long-Running Single-Process Live Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the current live-only runtime into a Linux-friendly 7x24 single-user trading daemon that can run unattended with durable state, bounded retries, circuit breaking, recovery checks, and flatten-only behavior.

**Architecture:** Keep one long-running Node.js process supervised by `systemd`. Preserve the existing strategy and execution chain, but add file-backed durable state snapshots, dependency health tracking, a runtime mode state machine, pending-submission recovery, and lightweight status and alert surfaces. Prefer atomic JSON snapshot files and existing JSONL journals over heavier infrastructure.

**Tech Stack:** Node.js 22, TypeScript, Vitest, YAML, Zod, JSONL journals, atomic JSON state snapshots, Linux `systemd`

---

### Task 1: Durable Runtime State Snapshots

**Files:**
- Create: `src/runtime/state-types.ts`
- Create: `src/runtime/atomic-file.ts`
- Create: `src/runtime/runtime-state-store.ts`
- Test: `tests/ts/runtime/runtime-state-store.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { RuntimeStateStore } from '../../../src/runtime/runtime-state-store';

describe('RuntimeStateStore', () => {
  it('persists and reloads runtime state snapshots', async () => {
    await rm('tmp/tests/runtime-state', { recursive: true, force: true });

    const store = new RuntimeStateStore('tmp/tests/runtime-state');
    await store.writeRuntimeState({
      mode: 'healthy',
      circuitReason: '',
      cooldownUntil: '',
      lastHealthyAt: '2026-03-22T00:00:00.000Z'
    });

    await expect(store.readRuntimeState()).resolves.toMatchObject({
      mode: 'healthy',
      lastHealthyAt: '2026-03-22T00:00:00.000Z'
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/runtime/runtime-state-store.test.ts`
Expected: FAIL because `RuntimeStateStore` does not exist.

**Step 3: Write minimal implementation**

```ts
// src/runtime/state-types.ts
export type RuntimeMode = 'healthy' | 'degraded' | 'circuit_open' | 'flatten_only' | 'paused' | 'recovering';

export type RuntimeStateSnapshot = {
  mode: RuntimeMode;
  circuitReason: string;
  cooldownUntil: string;
  lastHealthyAt: string;
};

// src/runtime/atomic-file.ts
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeJsonAtomically(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await rename(tempPath, path);
}

// src/runtime/runtime-state-store.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomically } from './atomic-file.ts';
import type { RuntimeStateSnapshot } from './state-types.ts';

export class RuntimeStateStore {
  constructor(private readonly rootDir: string) {}

  async writeRuntimeState(snapshot: RuntimeStateSnapshot) {
    await writeJsonAtomically(join(this.rootDir, 'runtime-state.json'), snapshot);
  }

  async readRuntimeState(): Promise<RuntimeStateSnapshot | null> {
    try {
      const raw = await readFile(join(this.rootDir, 'runtime-state.json'), 'utf8');
      return JSON.parse(raw) as RuntimeStateSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/runtime/runtime-state-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/state-types.ts src/runtime/atomic-file.ts src/runtime/runtime-state-store.ts tests/ts/runtime/runtime-state-store.test.ts
git commit -m "feat: add durable runtime state snapshots"
```

### Task 2: Dependency Health And Runtime Mode Policy

**Files:**
- Create: `src/runtime/dependency-health.ts`
- Create: `src/runtime/runtime-mode-policy.ts`
- Test: `tests/ts/runtime/dependency-health.test.ts`
- Test: `tests/ts/runtime/runtime-mode-policy.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { deriveRuntimeMode } from '../../../src/runtime/runtime-mode-policy';

describe('deriveRuntimeMode', () => {
  it('opens the circuit when broadcast health is unknown', () => {
    const result = deriveRuntimeMode({
      currentMode: 'healthy',
      quoteFailures: 0,
      reconcileFailures: 0,
      hasUnknownSubmissionOutcome: true,
      cooldownActive: false
    });

    expect(result.mode).toBe('circuit_open');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/runtime/dependency-health.test.ts tests/ts/runtime/runtime-mode-policy.test.ts`
Expected: FAIL because the policy modules do not exist.

**Step 3: Write minimal implementation**

```ts
// src/runtime/dependency-health.ts
export type DependencyHealth = {
  consecutiveFailures: number;
  lastSuccessAt: string;
  lastFailureAt: string;
  lastFailureReason: string;
};

export function markDependencyFailure(state: DependencyHealth, reason: string, at: string): DependencyHealth {
  return {
    ...state,
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailureAt: at,
    lastFailureReason: reason
  };
}

// src/runtime/runtime-mode-policy.ts
export function deriveRuntimeMode(input: {
  currentMode: 'healthy' | 'degraded' | 'circuit_open' | 'flatten_only' | 'paused' | 'recovering';
  quoteFailures: number;
  reconcileFailures: number;
  hasUnknownSubmissionOutcome: boolean;
  cooldownActive: boolean;
}) {
  if (input.hasUnknownSubmissionOutcome) {
    return { mode: 'circuit_open' as const, reason: 'unknown-submission-outcome' };
  }
  if (input.reconcileFailures >= 2) {
    return { mode: 'circuit_open' as const, reason: 'reconcile-failures' };
  }
  if (input.quoteFailures >= 5) {
    return { mode: 'circuit_open' as const, reason: 'quote-failures' };
  }
  if (input.quoteFailures >= 3) {
    return { mode: 'degraded' as const, reason: 'quote-degraded' };
  }
  if (input.cooldownActive) {
    return { mode: 'recovering' as const, reason: 'cooldown-active' };
  }
  return { mode: 'healthy' as const, reason: 'healthy' };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/runtime/dependency-health.test.ts tests/ts/runtime/runtime-mode-policy.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/dependency-health.ts src/runtime/runtime-mode-policy.ts tests/ts/runtime/dependency-health.test.ts tests/ts/runtime/runtime-mode-policy.test.ts
git commit -m "feat: add runtime mode policy"
```

### Task 3: Bounded Retry, Timeout, And Error Classification

**Files:**
- Create: `src/execution/request-resilience.ts`
- Create: `src/execution/error-classification.ts`
- Modify: `src/execution/http-live-quote-provider.ts`
- Modify: `src/execution/http-live-signer.ts`
- Modify: `src/execution/http-live-broadcaster.ts`
- Modify: `src/runtime/live-account-provider.ts`
- Test: `tests/ts/execution/request-resilience.test.ts`
- Test: `tests/ts/execution/error-classification.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { classifyExecutionError } from '../../../src/execution/error-classification';

describe('classifyExecutionError', () => {
  it('treats timeouts as transient errors', () => {
    const error = new Error('timeout');
    expect(classifyExecutionError(error, { status: 504 })).toEqual({
      kind: 'transient',
      reason: 'timeout'
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/execution/request-resilience.test.ts tests/ts/execution/error-classification.test.ts`
Expected: FAIL because resilience helpers do not exist.

**Step 3: Write minimal implementation**

```ts
// src/execution/error-classification.ts
export function classifyExecutionError(error: Error, metadata: { status?: number } = {}) {
  if (metadata.status === 429 || (metadata.status ?? 0) >= 500 || /timeout/i.test(error.message)) {
    return { kind: 'transient' as const, reason: 'timeout' };
  }
  return { kind: 'hard' as const, reason: error.message };
}

// src/execution/request-resilience.ts
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
  ]);
}
```

Then wrap the HTTP quote/signer/broadcaster/account providers so they:

- apply short timeouts
- retry only the allowed number of times
- rethrow classified errors with a consistent reason string

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/execution/request-resilience.test.ts tests/ts/execution/error-classification.test.ts tests/ts/execution/http-live-quote-provider.test.ts tests/ts/execution/http-live-signer.test.ts tests/ts/execution/http-live-broadcaster.test.ts tests/ts/runtime/live-account-provider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/execution/request-resilience.ts src/execution/error-classification.ts src/execution/http-live-quote-provider.ts src/execution/http-live-signer.ts src/execution/http-live-broadcaster.ts src/runtime/live-account-provider.ts tests/ts/execution/request-resilience.test.ts tests/ts/execution/error-classification.test.ts
git commit -m "feat: add bounded retry and timeout handling"
```

### Task 4: Pending Submission Tracking And Recovery Gate

**Files:**
- Create: `src/runtime/pending-submission-store.ts`
- Create: `src/runtime/recovery-gate.ts`
- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/execution/confirmation-tracker.ts`
- Test: `tests/ts/runtime/pending-submission-store.test.ts`
- Test: `tests/ts/runtime/recovery-gate.test.ts`
- Test: `tests/ts/runtime/live-cycle-production.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { shouldBlockForRecovery } from '../../../src/runtime/recovery-gate';

describe('shouldBlockForRecovery', () => {
  it('blocks new submission when a prior submission is unresolved', () => {
    expect(
      shouldBlockForRecovery({
        pendingSubmission: {
          idempotencyKey: 'k1',
          submissionId: 'sub-1',
          confirmationStatus: 'submitted'
        }
      })
    ).toEqual({ blocked: true, reason: 'pending-submission-recovery-required' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/runtime/pending-submission-store.test.ts tests/ts/runtime/recovery-gate.test.ts tests/ts/runtime/live-cycle-production.test.ts`
Expected: FAIL because recovery state is not yet persisted or enforced.

**Step 3: Write minimal implementation**

```ts
// src/runtime/recovery-gate.ts
export function shouldBlockForRecovery(input: {
  pendingSubmission: null | { confirmationStatus: 'submitted' | 'confirmed' | 'failed'; submissionId: string; idempotencyKey: string; };
}) {
  if (input.pendingSubmission && input.pendingSubmission.confirmationStatus === 'submitted') {
    return { blocked: true as const, reason: 'pending-submission-recovery-required' };
  }
  return { blocked: false as const, reason: 'clear' };
}
```

Then modify `runLiveCycle` so it:

- reads pending submission state before new execution
- blocks unsafe duplicate submission
- persists pending submission immediately after broadcast submission
- clears or updates pending state after confirmation and reconciliation

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/runtime/pending-submission-store.test.ts tests/ts/runtime/recovery-gate.test.ts tests/ts/runtime/live-cycle-production.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/pending-submission-store.ts src/runtime/recovery-gate.ts src/runtime/live-cycle.ts src/execution/confirmation-tracker.ts tests/ts/runtime/pending-submission-store.test.ts tests/ts/runtime/recovery-gate.test.ts tests/ts/runtime/live-cycle-production.test.ts
git commit -m "feat: add pending submission recovery gate"
```

### Task 5: Flatten-Only Runtime Policy Integration

**Files:**
- Create: `src/runtime/runtime-action-policy.ts`
- Modify: `src/runtime/live-cycle.ts`
- Modify: `src/risk/live-guards.ts`
- Test: `tests/ts/runtime/runtime-action-policy.test.ts`
- Test: `tests/ts/runtime/live-cycle.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { applyRuntimeActionPolicy } from '../../../src/runtime/runtime-action-policy';

describe('applyRuntimeActionPolicy', () => {
  it('blocks deploy while allowing dca-out in circuit_open mode', () => {
    expect(
      applyRuntimeActionPolicy({ mode: 'circuit_open', action: 'deploy' })
    ).toEqual({ action: 'hold', blockedReason: 'runtime-circuit-open' });

    expect(
      applyRuntimeActionPolicy({ mode: 'circuit_open', action: 'dca-out' })
    ).toEqual({ action: 'dca-out', blockedReason: '' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/runtime/runtime-action-policy.test.ts tests/ts/runtime/live-cycle.test.ts`
Expected: FAIL because runtime mode does not yet override strategy actions.

**Step 3: Write minimal implementation**

```ts
export function applyRuntimeActionPolicy(input: {
  mode: 'healthy' | 'degraded' | 'circuit_open' | 'flatten_only' | 'paused' | 'recovering';
  action: 'hold' | 'deploy' | 'dca-out';
}) {
  if (input.mode === 'circuit_open' && input.action === 'deploy') {
    return { action: 'hold' as const, blockedReason: 'runtime-circuit-open' };
  }
  if (input.mode === 'flatten_only' && input.action === 'deploy') {
    return { action: 'hold' as const, blockedReason: 'runtime-flatten-only' };
  }
  return { action: input.action, blockedReason: '' };
}
```

Then apply that policy before quote/sign/broadcast in `runLiveCycle`.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/runtime/runtime-action-policy.test.ts tests/ts/runtime/live-cycle.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/runtime-action-policy.ts src/runtime/live-cycle.ts src/risk/live-guards.ts tests/ts/runtime/runtime-action-policy.test.ts tests/ts/runtime/live-cycle.test.ts
git commit -m "feat: enforce flatten-only runtime policy"
```

### Task 6: Single-Process Daemon Loop And Health Surface

**Files:**
- Create: `src/runtime/live-daemon.ts`
- Create: `src/runtime/health-report.ts`
- Create: `src/cli/run-live-daemon-main.ts`
- Create: `src/cli/show-runtime-status-main.ts`
- Modify: `src/index.ts`
- Test: `tests/ts/runtime/live-daemon.test.ts`
- Test: `tests/ts/runtime/health-report.test.ts`
- Test: `tests/ts/cli/show-runtime-status.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildHealthReport } from '../../../src/runtime/health-report';

describe('buildHealthReport', () => {
  it('summarizes the current runtime mode and pending submission state', () => {
    const report = buildHealthReport({
      mode: 'degraded',
      allowNewOpens: false,
      flattenOnly: true,
      pendingSubmission: true
    });

    expect(report.mode).toBe('degraded');
    expect(report.pendingSubmission).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/health-report.test.ts tests/ts/cli/show-runtime-status.test.ts`
Expected: FAIL because the daemon and status surfaces do not exist.

**Step 3: Write minimal implementation**

```ts
// src/runtime/health-report.ts
export function buildHealthReport(input: {
  mode: string;
  allowNewOpens: boolean;
  flattenOnly: boolean;
  pendingSubmission: boolean;
}) {
  return {
    mode: input.mode,
    allowNewOpens: input.allowNewOpens,
    flattenOnly: input.flattenOnly,
    pendingSubmission: input.pendingSubmission,
    updatedAt: new Date().toISOString()
  };
}
```

Then implement `live-daemon.ts` as a simple loop that:

- reads persisted runtime state
- runs one cycle
- writes `state/health.json`
- waits until the next tick

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/health-report.test.ts tests/ts/cli/show-runtime-status.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/live-daemon.ts src/runtime/health-report.ts src/cli/run-live-daemon-main.ts src/cli/show-runtime-status-main.ts src/index.ts tests/ts/runtime/live-daemon.test.ts tests/ts/runtime/health-report.test.ts tests/ts/cli/show-runtime-status.test.ts
git commit -m "feat: add long-running daemon and status cli"
```

### Task 7: Lightweight Alert Sink

**Files:**
- Create: `src/runtime/alert-sink.ts`
- Create: `src/runtime/http-alert-sink.ts`
- Test: `tests/ts/runtime/alert-sink.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { shouldSendAlert } from '../../../src/runtime/alert-sink';

describe('shouldSendAlert', () => {
  it('alerts on circuit_open but not on healthy ticks', () => {
    expect(shouldSendAlert({ previousMode: 'healthy', nextMode: 'circuit_open', reason: 'quote-failures' })).toBe(true);
    expect(shouldSendAlert({ previousMode: 'healthy', nextMode: 'healthy', reason: 'healthy' })).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/runtime/alert-sink.test.ts`
Expected: FAIL because the alert sink does not exist.

**Step 3: Write minimal implementation**

```ts
export function shouldSendAlert(input: {
  previousMode: string;
  nextMode: string;
  reason: string;
}) {
  return input.previousMode !== input.nextMode && ['circuit_open', 'flatten_only'].includes(input.nextMode);
}
```

Then add a simple HTTP webhook sender for Telegram/Feishu-style bots and call it only on operator-actionable state changes.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/runtime/alert-sink.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/alert-sink.ts src/runtime/http-alert-sink.ts tests/ts/runtime/alert-sink.test.ts
git commit -m "feat: add lightweight runtime alerts"
```

### Task 8: Linux Service Packaging And Operator Docs

**Files:**
- Create: `ops/systemd/lightld.service`
- Create: `docs/runbooks/long-running-live-runtime.md`
- Modify: `README.md`

**Step 1: Write the operator-facing service unit and runbook**

Create a `systemd` unit that runs:

```ini
[Unit]
Description=Lightld long-running live runtime
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/lightld
ExecStart=/usr/bin/node --experimental-strip-types src/cli/run-live-daemon-main.ts
Restart=always
RestartSec=5
User=lightld
EnvironmentFile=/etc/lightld.env

[Install]
WantedBy=multi-user.target
```

Document:

- required env vars
- state directory layout
- health file inspection
- pause / resume flow
- restart recovery expectations

**Step 2: Run documentation sanity review**

Run: `Get-Content README.md`, `Get-Content docs/runbooks/long-running-live-runtime.md`
Expected: clear Linux-first instructions with no shadow/paper references.

**Step 3: Update README**

Add sections for:

- long-running daemon mode
- health/status CLI
- runtime modes
- alert webhook configuration
- recommended Linux layout

**Step 4: Verify docs reflect the actual entrypoints**

Run: `npm test -- tests/ts/cli/show-runtime-status.test.ts tests/ts/runtime/live-daemon.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ops/systemd/lightld.service docs/runbooks/long-running-live-runtime.md README.md
git commit -m "docs: add long-running live runtime ops guide"
```

### Task 9: Full Verification And Recovery Drill

**Files:**
- Modify: `README.md`
- Verify: `tests/ts/**`

**Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS across existing strategy, ingest, runtime, execution, journal, and new daemon-state tests.

**Step 2: Run the TypeScript compiler**

Run: `npm run build`
Expected: PASS with no type errors.

**Step 3: Run a manual recovery drill**

Simulate:

- a persisted pending submission file
- process restart
- status CLI output
- runtime refusing a duplicate submission until recovery completes

Expected: the runtime stays blocked for safety and exposes the reason in `state/health.json`.

**Step 4: Review the final Linux operator flow**

Confirm the project can now support:

- one `systemd` service
- one health file
- one status CLI
- bounded retry and timeout behavior
- flatten-only protection

**Step 5: Commit**

```bash
git add README.md
git commit -m "chore: finalize long-running live runtime verification"
```
