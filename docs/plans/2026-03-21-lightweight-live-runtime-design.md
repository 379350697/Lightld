# Lightweight Live Runtime Design

## Context

The workspace root at `D:\codex2\Lightld` is currently empty. The reference implementation has been cloned into `D:\codex2\Lightld\liudx-ref` and will be treated as read-only source material.

The lightweight version will be built as a new TypeScript project in the workspace root. It will keep the reference project's trading logic, strategy logic, and primary live execution path, while removing every shadow, paper, and replay/backtest path.

## Goals

- Preserve the strategy behavior for `new-token-v1` and `large-pool-v1`.
- Preserve the existing hard-gate behavior around SOL routing and minimum liquidity.
- Preserve the main live trading flow from context building through order submission and journal output.
- Reduce the codebase to one runtime path that is easy to understand and operate.

## Non-Goals

- No shadow runtime.
- No paper runtime.
- No Python replay or backtest tooling.
- No CLI or status surface that exists only for shadow or paper workflows.
- No change to strategy decisions, guard behavior, or live journal semantics beyond what is required to remove unused layers.

## Chosen Approach

The implementation will follow the "minimal refactor" approach:

- Keep the reusable strategy, config, ingest, execution, risk, and journal concepts.
- Replace the shadow-plus-canary layering with a single `live-cycle` runtime.
- Keep the operator entrypoint shape centered around `run-strategy-cycle`.
- Build only the files needed for a live-only system in the new workspace root.

This keeps the important behavior intact while removing indirection and unused subsystems.

## Target Architecture

### Retained concepts

- `config`
  - Strategy schema and YAML strategy files remain the source of truth.
- `strategy`
  - `engine-runner`
  - `engines/new-token-engine`
  - `engines/large-pool-engine`
  - `filtering/hard-gates`
- `ingest`
  - Market data adapters remain the source for raw context inputs.
- `execution`
  - Quote collection, execution-plan construction, order-intent building, signer, and broadcaster remain separate concerns.
- `risk`
  - Live guard checks stay between strategy decision and order submission.
- `journals`
  - Decision, quote, live order, live fill, and incident journals remain append-only JSONL outputs.

### Removed concepts

- `runtime/shadow-cycle`
- `runtime/paper-cycle`
- `paper/*`
- `python/backtest/*`
- `python/tests/*`
- Shadow and paper CLI entrypoints
- Shadow and paper runbooks

### New runtime layout

- `src/runtime/build-decision-context.ts`
- `src/runtime/kill-switch.ts`
- `src/runtime/live-cycle.ts`
- `src/runtime/live-mode-controller.ts`
- `src/runtime/live-whitelist.ts`

The single runtime entrypoint is `live-cycle.ts`. It replaces the old `shadow-cycle -> canary-cycle` handoff and returns the final live result directly.

## Main Data Flow

The live-only system will use this fixed path:

1. Load strategy config.
2. Accept or assemble market context.
3. Build the normalized decision context.
4. Build the strategy engine snapshot from that context.
5. Run the strategy engine.
6. If the result is `hold`, record the decision and stop.
7. If the result is actionable, collect a live quote.
8. Build an execution plan.
9. Evaluate live guards.
10. Build an order intent.
11. Sign and broadcast the order.
12. Write live journals.
13. Return a single live runtime result.

This keeps the original sequencing of decision, quoting, planning, guarding, submission, and journaling, but removes the extra shadow and paper layers.

## Strategy Behavior To Preserve

### `new-token-v1`

- Hard gates still apply first.
- Decision rule stays:
  - `inSession && hasInventory -> dca-out`
  - otherwise `hold`

### `large-pool-v1`

- Hard gates still apply first.
- Decision rule stays:
  - `score >= minScore -> deploy`
  - otherwise `hold`

## Runtime Contracts

### Input

`live-cycle` will accept a compact input contract:

```ts
type LiveCycleInput = {
  strategy: 'new-token-v1' | 'large-pool-v1';
  context?: DecisionContextInput;
  killSwitch?: KillSwitch;
  whitelist?: string[];
  requestedPositionSol?: number;
  sessionPhase?: 'active' | 'flatten-only' | 'closed';
  reconciliationStatus?: 'matched' | 'balance-mismatch';
};
```

### Output

`live-cycle` will return a single operator-facing result:

```ts
type LiveCycleResult = {
  status: 'ok';
  mode: 'LIVE' | 'BLOCKED';
  action: 'hold' | 'deploy' | 'dca-out';
  reason: string;
  audit: { reason: string };
  context: ReturnType<typeof buildDecisionContext>;
  quoteCollected: boolean;
  quote?: SolExitQuote;
  executionPlan?: ExecutionPlan;
  liveOrderSubmitted: boolean;
  orderIntent?: LiveOrderIntent;
  broadcastResult?: BroadcastResult;
  journalPaths: {
    decisionAuditPath: string;
    quoteJournalPath: string;
    liveOrderPath: string;
    liveFillPath: string;
    liveIncidentPath: string;
  };
  killSwitchState: boolean;
};
```

The important simplification is that operators no longer need to understand separate shadow, paper, and canary result shapes.

## Error Handling And Safety

- A kill switch remains a first-class input and must stop live execution before submission.
- Live guard checks remain responsible for whitelist, session-phase, and position-cap enforcement.
- `hold` remains a normal strategy result, not an error.
- Guard failures remain normal blocked outcomes with explicit reasons.
- Journals remain append-only and should still be written for decisions and live incidents so operator follow-up stays possible.

## Testing Strategy

The lightweight version will keep only the tests that prove behavior on the retained path:

1. Strategy tests
   - `new-token-engine`
   - `large-pool-engine`
   - `hard-gates`

2. Runtime tests
   - `live-cycle` happy path
   - `hold` path
   - kill switch blocked path
   - whitelist blocked path
   - position-cap blocked path

3. CLI smoke tests
   - `run-strategy-cycle`

The design intentionally removes all shadow, paper, and Python replay tests because those subsystems will not exist in the lightweight build.

## Migration Notes

- The new root project will be assembled from selected logic in `liudx-ref`.
- `liudx-ref` remains untouched so behavior can be compared during implementation.
- Because the current root is not a git repository, design and plan documents can be saved locally now, but committing them is blocked until a repository is initialized or provided.

## Acceptance Criteria

- The two strategies produce the same actions as the reference logic for equivalent inputs.
- Live guards preserve the same allow and block behavior as the reference logic.
- The operator path is a single live-only flow.
- Journals are still produced for decision, quote, order, fill, and incident events.
- There is no shadow runtime, paper runtime, or Python backtest surface in the delivered project.
