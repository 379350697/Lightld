# Lightweight Live Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a new lightweight TypeScript trading project that keeps the reference strategy and live trading behavior while removing shadow, paper, and backtest subsystems.

**Architecture:** The new project will live at the workspace root and will recreate only the live-only modules needed from the reference repo in `liudx-ref/`. A single `live-cycle` runtime will replace the old shadow-plus-canary layering while keeping strategy decisions, hard gates, live guards, and journal outputs aligned with the reference behavior.

**Tech Stack:** Node.js, TypeScript, Vitest, YAML, Zod

---

## Pre-Task Setup

These steps are setup rather than production behavior, so they can happen before TDD tasks begin.

- Create `.gitignore`, `package.json`, `tsconfig.json`, and `vitest.config.ts` in `D:\codex2\Lightld`.
- Mirror the dependency versions already validated in `D:\codex2\Lightld\liudx-ref\package.json`.
- Install Node dependencies with `npm install`.
- Keep `D:\codex2\Lightld\liudx-ref` read-only so it remains a clean reference during implementation.

### Task 1: Strategy Config Loading

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/loader.ts`
- Create: `src/config/strategies/new-token-v1.yaml`
- Create: `src/config/strategies/large-pool-v1.yaml`
- Test: `tests/ts/config/loader.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { loadStrategyConfig } from '../../../src/config/loader';

describe('loadStrategyConfig', () => {
  it('loads the new-token strategy config from YAML', async () => {
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');

    expect(config.strategyId).toBe('new-token-v1');
    expect(config.poolClass).toBe('new-token');
    expect(config.live.enabled).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/ts/config/loader.test.ts`
Expected: FAIL with a module-not-found error for `src/config/loader`.

**Step 3: Write minimal implementation**

```ts
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const StrategyConfigSchema = z.object({
  strategyId: z.string(),
  poolClass: z.enum(['new-token', 'large-pool']),
  exitMint: z.literal('SOL'),
  hardGates: z.object({
    requireSolRoute: z.boolean(),
    minLiquidityUsd: z.number().nonnegative()
  }),
  filters: z.object({
    minHolders: z.number().int().positive(),
    minLiquidityUsd: z.number().nonnegative()
  }),
  scoringWeights: z.object({
    holders: z.number(),
    liquidity: z.number(),
    momentum: z.number()
  }),
  riskThresholds: z.object({
    maxPositionSol: z.number().positive(),
    maxDailyLossSol: z.number().positive()
  }),
  sessionWindows: z.array(z.object({ start: z.string(), end: z.string() })).min(1),
  solRouteLimits: z.object({
    maxSlippageBps: z.number().int().nonnegative(),
    maxImpactBps: z.number().int().nonnegative()
  }),
  live: z.object({
    enabled: z.boolean(),
    maxLivePositionSol: z.number().positive(),
    autoFlattenRequired: z.boolean(),
    requireWhitelist: z.boolean()
  })
});

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export async function loadStrategyConfig(path: string): Promise<StrategyConfig> {
  const raw = await readFile(path, 'utf8');
  return StrategyConfigSchema.parse(parse(raw));
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/ts/config/loader.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config tests/ts/config/loader.test.ts package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "feat: add strategy config loader"
```

### Task 2: Strategy Engines And Hard Gates

**Files:**
- Create: `src/strategy/engines/new-token-engine.ts`
- Create: `src/strategy/engines/large-pool-engine.ts`
- Create: `src/strategy/filtering/hard-gates.ts`
- Create: `src/strategy/engine-runner.ts`
- Test: `tests/ts/strategy/new-token-engine.test.ts`
- Test: `tests/ts/strategy/large-pool-engine.test.ts`
- Test: `tests/ts/strategy/hard-gates.test.ts`
- Test: `tests/ts/strategy/engine-runner.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { runEngineCycle } from '../../../src/strategy/engine-runner';

describe('runEngineCycle', () => {
  it('returns dca-out for actionable new-token snapshots', () => {
    const result = runEngineCycle({
      engine: 'new-token',
      snapshot: { inSession: true, hasInventory: true, hasSolRoute: true, liquidityUsd: 10000 },
      config: { requireSolRoute: true, minLiquidityUsd: 5000, minScore: 70 }
    });

    expect(result.action).toBe('dca-out');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/ts/strategy/*.test.ts`
Expected: FAIL because `runEngineCycle` and related modules do not exist yet.

**Step 3: Write minimal implementation**

```ts
export function buildNewTokenDecision(snapshot: { inSession: boolean; hasInventory: boolean }) {
  return {
    action: snapshot.inSession && snapshot.hasInventory ? 'dca-out' : 'hold'
  };
}

export function buildLargePoolDecision(snapshot: { score: number }, config: { minScore: number }) {
  return {
    action: snapshot.score >= config.minScore ? 'deploy' : 'hold'
  };
}

export function evaluateHardGates(
  snapshot: { hasSolRoute: boolean; liquidityUsd?: number },
  config: { requireSolRoute: boolean; minLiquidityUsd?: number }
) {
  const reasons: string[] = [];
  if (config.requireSolRoute && !snapshot.hasSolRoute) reasons.push('missing-sol-route');
  if ((snapshot.liquidityUsd ?? 0) < (config.minLiquidityUsd ?? 0)) reasons.push('liquidity-too-low');
  return { accepted: reasons.length === 0, reasons };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/ts/strategy/*.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/strategy tests/ts/strategy
git commit -m "feat: add strategy engines and hard gates"
```

### Task 3: Decision Context And Execution Primitives

**Files:**
- Create: `src/runtime/build-decision-context.ts`
- Create: `src/execution/types.ts`
- Create: `src/execution/sol-exit-quote.ts`
- Create: `src/execution/build-execution-plan.ts`
- Create: `src/execution/order-intent-builder.ts`
- Test: `tests/ts/runtime/build-decision-context.test.ts`
- Test: `tests/ts/execution/build-execution-plan.test.ts`
- Test: `tests/ts/execution/order-intent-builder.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildDecisionContext } from '../../../src/runtime/build-decision-context';

describe('buildDecisionContext', () => {
  it('normalizes missing sections to empty objects', () => {
    const context = buildDecisionContext({});

    expect(context.pool).toEqual({});
    expect(context.route).toEqual({});
    expect(context.createdAt).toMatch(/T/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/ts/runtime/build-decision-context.test.ts tests/ts/execution/build-execution-plan.test.ts tests/ts/execution/order-intent-builder.test.ts`
Expected: FAIL because the runtime and execution primitives do not exist.

**Step 3: Write minimal implementation**

```ts
export type DecisionContextInput = {
  pool?: Record<string, unknown>;
  token?: Record<string, unknown>;
  trader?: Record<string, unknown>;
  route?: Record<string, unknown>;
};

export function buildDecisionContext(input: DecisionContextInput) {
  return {
    createdAt: new Date().toISOString(),
    pool: input.pool ?? {},
    token: input.token ?? {},
    trader: input.trader ?? {},
    route: input.route ?? {}
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/ts/runtime/build-decision-context.test.ts tests/ts/execution/build-execution-plan.test.ts tests/ts/execution/order-intent-builder.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/build-decision-context.ts src/execution tests/ts/runtime/build-decision-context.test.ts tests/ts/execution
git commit -m "feat: add execution primitives"
```

### Task 4: Live Guards And Execution Adapters

**Files:**
- Create: `src/risk/live-guards.ts`
- Create: `src/runtime/kill-switch.ts`
- Create: `src/runtime/live-whitelist.ts`
- Create: `src/runtime/live-mode-controller.ts`
- Create: `src/execution/live-signer.ts`
- Create: `src/execution/live-broadcaster.ts`
- Create: `src/execution/live-quote-service.ts`
- Test: `tests/ts/risk/live-guards.test.ts`
- Test: `tests/ts/runtime/kill-switch.test.ts`
- Test: `tests/ts/execution/live-signer.test.ts`
- Test: `tests/ts/execution/live-broadcaster.test.ts`
- Test: `tests/ts/execution/live-quote-service.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { evaluateLiveGuards } from '../../../src/risk/live-guards';

describe('evaluateLiveGuards', () => {
  it('blocks when the kill switch is engaged', () => {
    const result = evaluateLiveGuards({
      symbol: 'SAFE',
      whitelist: ['SAFE'],
      requestedPositionSol: 0.1,
      maxLivePositionSol: 0.25,
      killSwitchEngaged: true,
      requireWhitelist: true,
      sessionPhase: 'active'
    });

    expect(result).toEqual({ allowed: false, reason: 'kill-switch-engaged' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/ts/risk/live-guards.test.ts tests/ts/runtime/kill-switch.test.ts tests/ts/execution/live-*.test.ts`
Expected: FAIL because the guard and live execution adapters do not exist yet.

**Step 3: Write minimal implementation**

```ts
export function evaluateLiveGuards(input: {
  symbol: string;
  whitelist: string[];
  requestedPositionSol: number;
  maxLivePositionSol: number;
  killSwitchEngaged: boolean;
  requireWhitelist?: boolean;
  sessionPhase?: 'active' | 'flatten-only' | 'closed';
}) {
  if (input.killSwitchEngaged) return { allowed: false, reason: 'kill-switch-engaged' as const };
  if (input.sessionPhase === 'flatten-only' || input.sessionPhase === 'closed') {
    return { allowed: false, reason: 'flatten-only' as const };
  }
  if ((input.requireWhitelist ?? true) && !input.whitelist.includes(input.symbol)) {
    return { allowed: false, reason: 'token-not-whitelisted' as const };
  }
  if (input.requestedPositionSol > input.maxLivePositionSol) {
    return { allowed: false, reason: 'live-position-cap-exceeded' as const };
  }
  return { allowed: true, reason: 'allowed' as const };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/ts/risk/live-guards.test.ts tests/ts/runtime/kill-switch.test.ts tests/ts/execution/live-*.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/risk src/runtime src/execution tests/ts/risk tests/ts/runtime/kill-switch.test.ts tests/ts/execution
git commit -m "feat: add live guards and execution adapters"
```

### Task 5: JSONL Journals

**Files:**
- Create: `src/journals/jsonl-writer.ts`
- Create: `src/journals/decision-audit-log.ts`
- Create: `src/journals/quote-journal.ts`
- Create: `src/journals/live-order-journal.ts`
- Create: `src/journals/live-fill-journal.ts`
- Create: `src/journals/live-incident-journal.ts`
- Test: `tests/ts/journals/decision-audit-log.test.ts`
- Test: `tests/ts/journals/quote-journal.test.ts`
- Test: `tests/ts/journals/live-order-journal.test.ts`
- Test: `tests/ts/journals/live-fill-journal.test.ts`
- Test: `tests/ts/journals/live-incident-journal.test.ts`

**Step 1: Write the failing tests**

```ts
import { readFile, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DecisionAuditLog } from '../../../src/journals/decision-audit-log';

describe('DecisionAuditLog', () => {
  it('appends JSONL records', async () => {
    const path = 'tmp/journals/test-decision-audit.jsonl';
    await rm(path, { force: true });

    const journal = new DecisionAuditLog(path);
    await journal.append({ strategyId: 'new-token-v1', action: 'hold', reason: 'test', recordedAt: new Date().toISOString() });

    const content = await readFile(path, 'utf8');
    expect(content).toContain('"strategyId":"new-token-v1"');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/ts/journals/*.test.ts`
Expected: FAIL because the journal writer and concrete journals do not exist.

**Step 3: Write minimal implementation**

```ts
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class JsonlWriter<T> {
  constructor(private readonly path: string) {}

  async append(record: T) {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/ts/journals/*.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/journals tests/ts/journals
git commit -m "feat: add live journals"
```

### Task 6: Single Live Runtime

**Files:**
- Create: `src/runtime/live-cycle.ts`
- Test: `tests/ts/runtime/live-cycle.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { KillSwitch } from '../../../src/runtime/kill-switch';
import { runLiveCycle } from '../../../src/runtime/live-cycle';

describe('runLiveCycle', () => {
  it('submits a live order for actionable new-token input', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      whitelist: ['SAFE'],
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('dca-out');
    expect(result.liveOrderSubmitted).toBe(true);
  });

  it('blocks when the kill switch is engaged', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      killSwitch: new KillSwitch(true),
      whitelist: ['SAFE'],
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('kill-switch-engaged');
    expect(result.liveOrderSubmitted).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/ts/runtime/live-cycle.test.ts`
Expected: FAIL because `src/runtime/live-cycle.ts` does not exist yet.

**Step 3: Write minimal implementation**

```ts
const STRATEGY_CONFIGS = {
  'new-token-v1': 'src/config/strategies/new-token-v1.yaml',
  'large-pool-v1': 'src/config/strategies/large-pool-v1.yaml'
} as const;

export async function runLiveCycle(input: LiveCycleInput) {
  const config = await loadStrategyConfig(STRATEGY_CONFIGS[input.strategy]);
  const context = buildDecisionContext(input.context ?? {});
  const killSwitch = input.killSwitch ?? new KillSwitch(false);
  const result = runEngineCycle(/* build snapshot from context */);

  if (result.action === 'hold') {
    return {
      status: 'ok',
      mode: 'BLOCKED',
      action: 'hold',
      reason: 'hold',
      audit: result.audit,
      context,
      quoteCollected: false,
      liveOrderSubmitted: false,
      journalPaths,
      killSwitchState: killSwitch.isEngaged()
    };
  }

  // Collect quote, build plan, evaluate guards, build intent, sign, broadcast, write journals.
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/ts/runtime/live-cycle.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/live-cycle.ts tests/ts/runtime/live-cycle.test.ts
git commit -m "feat: add live-only runtime"
```

### Task 7: Operator CLI And Public Exports

**Files:**
- Create: `src/cli/run-strategy-cycle.ts`
- Create: `src/cli/run-strategy-cycle-main.ts`
- Create: `src/index.ts`
- Create: `README.md`
- Test: `tests/ts/cli/run-strategy-cycle.test.ts`
- Test: `tests/ts/smoke.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { runStrategyCycle } from '../../../src/cli/run-strategy-cycle';

describe('runStrategyCycle', () => {
  it('returns a live decision summary', async () => {
    const result = await runStrategyCycle({
      strategy: 'new-token-v1',
      requestedPositionSol: 0.1,
      whitelist: ['SAFE'],
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.status).toBe('ok');
    expect(result.mode).toBe('LIVE');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/ts/cli/run-strategy-cycle.test.ts tests/ts/smoke.test.ts`
Expected: FAIL because the CLI wrapper and root exports do not exist yet.

**Step 3: Write minimal implementation**

```ts
export async function runStrategyCycle(input: LiveCycleInput) {
  return runLiveCycle(input);
}

export * from './cli/run-strategy-cycle';
export * from './runtime/live-cycle';
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/ts/cli/run-strategy-cycle.test.ts tests/ts/smoke.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli src/index.ts README.md tests/ts/cli tests/ts/smoke.test.ts
git commit -m "feat: add live strategy operator entrypoint"
```

### Task 8: Full Verification And Cleanup

**Files:**
- Modify: `README.md`
- Verify: `tests/ts/**`

**Step 1: Add the final verification checklist to the README**

```md
## Verification

```bash
npm test
```
```

**Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS across config, strategy, execution, risk, journals, runtime, CLI, and smoke tests.

**Step 3: Run the TypeScript compiler**

Run: `npm run build`
Expected: PASS with no type errors.

**Step 4: Review the repository layout**

Confirm that these paths do not exist in the final project:

- `src/paper`
- `src/runtime/shadow-cycle.ts`
- `src/runtime/paper-cycle.ts`
- `python/`

**Step 5: Commit**

```bash
git add README.md
git commit -m "docs: finalize lightweight live runtime"
```
