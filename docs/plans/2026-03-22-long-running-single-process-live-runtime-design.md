# Long-Running Single-Process Live Runtime Design

## Context

The current project in `D:\codex2\Lightld` is already a lightweight live-only runtime. It preserves the strategy logic, hard-gate logic, and main execution path, and it can run in a canary-style live integration mode through external quote, signer, broadcaster, and account-state services.

The new requirement is narrower and more operationally demanding:

- one user
- Linux-first deployment
- 7x24 unattended operation
- low resource usage
- no extra distributed infrastructure unless clearly necessary
- trading logic, strategy logic, and primary execution chain must remain intact

This means the next phase is no longer about strategy behavior. It is about long-running runtime safety, restart recovery, dependency degradation, and single-user operability.

## Goals

- Keep the existing strategy decisions unchanged.
- Keep the existing execution chain shape unchanged: ingest -> decision -> quote -> execution plan -> live guards -> sign -> broadcast -> journals.
- Upgrade the runtime so one person can operate it continuously on one Linux machine.
- Make the system default to preservation over aggression when dependencies become unreliable.
- Keep the deployment lightweight: one service, minimal dependencies, small memory footprint.

## Non-Goals

- No multi-tenant design.
- No distributed queue, Redis, Kubernetes, or service mesh.
- No dashboard-heavy platform buildout.
- No strategy redesign.
- No high-frequency or ultra-low-latency optimization work.

## Approaches Considered

### 1. Ultra-simple single process

One loop, one process, append logs, let `systemd` restart it on failure.

Pros:

- smallest code change
- lowest resource usage
- easiest deployment

Cons:

- weak restart recovery
- poor protection around uncertain broadcast outcomes
- too fragile for unattended 7x24 funds

### 2. Reinforced single process

One long-running process, but with explicit runtime modes, durable state snapshots, bounded retries, circuit breaking, recovery checks, and health outputs.

Pros:

- keeps deployment simple
- preserves low resource usage
- materially improves unattended safety
- fits a single-user Linux environment well

Cons:

- more runtime code than the current canary-oriented version
- still a single runtime unit, so state durability and restart behavior must be done carefully

### 3. Lightweight multi-process split

Separate ingest/scheduler and execution/guard loops into different local processes.

Pros:

- stronger isolation
- better fault containment

Cons:

- more moving parts
- more state synchronization and anti-duplication work
- not aligned with the user's preference for lightweight, single-machine operation

## Chosen Approach

The chosen design is **reinforced single process**.

The runtime will stay as one Node.js service on one Linux host, supervised by `systemd`. Internally, it will behave like a small state machine rather than a best-effort loop. The process will keep using append-only JSONL journals for auditability, but it will gain durable state snapshots so that restarts and uncertain submissions can be handled safely.

To stay lightweight, phase one will use **atomic file-backed state** rather than Redis or any external store. The durable runtime state will live under `state/` as small JSON snapshot files written with atomic rename semantics. Existing JSONL journals stay under `tmp/journals/` or an operator-configured journal directory.

## Runtime Architecture

The runtime stays a single service, but the service will be internally split into these logical modules:

- `scheduler`
  drives the main tick cadence, cooldown windows, and heartbeat timing
- `ingest`
  wraps Meteora and other market inputs with timeouts, throttling, and short retries
- `engine`
  runs the unchanged trading and strategy logic
- `risk gate`
  applies whitelist rules, position limits, runtime mode rules, and flatten-only restrictions
- `executor`
  performs quote, sign, broadcast, confirm, and reconcile steps
- `runtime state`
  stores mode, dependency health, pending submissions, and health summaries durably
- `ops surface`
  writes health snapshots, emits alerts, and exposes a small local status CLI

This preserves the current codebase shape while making the runtime operationally safer.

## Main Data Flow

The long-running process will execute this loop:

1. Load durable runtime state.
2. Check whether the process is in `healthy`, `degraded`, `circuit_open`, `flatten_only`, `paused`, or `recovering`.
3. If a pending submission exists, run recovery checks before allowing any new submission.
4. Collect market data with bounded retry and timeout policy.
5. Build the decision context and run the unchanged strategy engine.
6. Convert the strategy action through the active runtime mode:
   - `healthy`: allow normal strategy behavior
   - `degraded`: allow behavior with tighter cadence or stricter limits
   - `circuit_open`: block new deploys, allow only safe reductions
   - `flatten_only`: allow only reduction paths
7. If execution is allowed, collect quote, build plan, sign, broadcast, and attempt confirmation.
8. Reconcile wallet state against journal/account state.
9. Update durable runtime state, append journals, and write health output.
10. Sleep until the next scheduled tick.

The strategy does not become responsible for runtime safety. Runtime mode always has final authority over whether an otherwise valid strategy action may execute.

## Runtime Modes

The runtime will use a small explicit mode model:

- `healthy`
  normal trading behavior
- `degraded`
  dependencies are shaky; the process remains live but acts more conservatively
- `circuit_open`
  no new position increases; only safe reduction paths are permitted
- `flatten_only`
  only reduction or exit actions are allowed
- `paused`
  operator pause; monitoring and status remain active
- `recovering`
  restart or post-failure validation mode; no normal trading resumes until checks pass

These modes are operator-facing and should appear in status output, health files, and alert payloads.

## Durable State

To keep the system lightweight without sacrificing restart behavior, the runtime will persist a few small JSON snapshot files:

- `state/runtime-state.json`
  current mode, current circuit reason, cooldown deadline, last healthy timestamp
- `state/dependency-health.json`
  recent success/failure counters for quote, signer, broadcaster, and reconcile dependencies
- `state/pending-submission.json`
  current unresolved submission, idempotency key, submission id, timestamps, last known confirmation state
- `state/position-state.json`
  current user-facing position summary and whether the runtime currently allows new risk
- `state/health.json`
  operator summary for quick inspection

Each file must be written atomically:

1. write to a temp file in the same directory
2. fsync if needed for the platform choice
3. rename into place

Append-only journals remain the source of audit truth, while the snapshot files provide fast current-state recovery.

## Error Handling

Errors are classified into three operator-relevant categories:

- `transient`
  timeout, `429`, `5xx`, short network failures
- `hard`
  validation errors, explicit business rejection, invalid configuration, deterministic misuse
- `unknown`
  the system cannot prove whether a submission happened or not

The design response is:

- transient errors use bounded retry and then contribute to dependency degradation
- hard errors move the runtime toward `circuit_open` quickly
- unknown submission outcomes freeze new submission attempts until confirmation and reconciliation checks complete

## Timeouts And Retry Policy

The runtime uses short bounded retries inside a single tick:

- quote: timeout about `1500ms`, up to `2` retries
- signer: timeout about `2000ms`, up to `1` retry
- broadcaster: timeout about `2500ms`, up to `1` retry
- account/reconcile: timeout about `2000ms`, up to `2` retries

Retries use exponential backoff with jitter and must fit within the current tick's execution budget. If the budget is exhausted, the tick ends and the runtime records degraded dependency health instead of pushing the next tick late.

## Circuit Breaking And Recovery

Each external dependency tracks a small rolling health summary. The aggregate runtime mode is derived from these summaries and from submission safety signals.

Recommended initial policy:

- repeated quote failures push the runtime from `healthy` to `degraded`, then to `circuit_open`
- any unknown signer or broadcast outcome opens the circuit immediately
- repeated reconcile mismatches open the circuit immediately
- an unresolved submission combined with a reconcile anomaly escalates to `flatten_only`

Recovery is intentionally slower than failure:

- `circuit_open` enforces a cooldown period
- after cooldown, the runtime enters `recovering`
- only after healthy checks succeed does it return to `healthy`

## Flatten-Only Behavior

The user explicitly chose the following policy:

- on circuit break, stop opening new risk
- continue reducing risk along existing strategy-sanctioned reduction paths

That means:

- `deploy` is blocked in `circuit_open` and `flatten_only`
- `dca-out` remains allowed in `circuit_open`
- `flatten_only` may further clamp reduction size and cadence to avoid panic execution into thin liquidity

This keeps the strategy logic intact while letting the runtime enforce capital preservation.

## Linux Deployment Model

The deployment target is one Linux host with one long-running service:

- one `systemd` unit
- one working directory
- one process
- `journald` for process logs
- JSONL journals for audit logs
- local `state/` snapshots for durable current state

This avoids operational sprawl and fits a one-person workflow.

## Operator Surfaces

The runtime should expose two lightweight operator interfaces:

- `state/health.json`
  fast machine-readable status for SSH checks or scripts
- `show-runtime-status` CLI
  human-readable snapshot of mode, pending submission state, dependency health, and whether new entries are allowed

The minimal fields that must always be visible are:

- current mode
- whether new opens are allowed
- whether the runtime is in flatten-only behavior
- whether a submission is pending confirmation
- last successful tick time
- current circuit reason

## Alerts

The system should alert only on operator-actionable events:

- `circuit_open`
- `flatten_only`
- repeated reconcile failure
- unresolved submission timeout
- repeated process restart
- low disk space
- prolonged dependency outage

For a single user, a simple bot-based alert sink such as Telegram or Feishu is sufficient and preferred over a heavier monitoring stack.

## Testing Strategy

The design should be verified through:

- unit tests for retry policy, error classification, runtime mode transitions, and atomic snapshot writes
- runtime tests for pending submission recovery and flatten-only gating
- daemon-loop tests for health-file updates and status transitions
- CLI tests for status reporting
- integration-style tests for restart recovery with a previously persisted pending submission

## Acceptance Criteria

- The strategy engine outputs the same trading actions for the same market inputs.
- The runtime can restart with a persisted unresolved submission and refuse unsafe duplicate submission.
- Dependency failures can move the runtime into `degraded`, `circuit_open`, and `flatten_only`.
- The runtime can block new opens while still allowing reduction actions.
- The process exposes a health snapshot that is enough for one-person operation.
- The deployment remains one Linux service with no extra distributed infrastructure.

## Notes

- The current workspace root is still not a git repository, so the design can be saved locally but cannot be committed yet.
- This design intentionally favors predictable recovery and capital protection over maximum throughput.
