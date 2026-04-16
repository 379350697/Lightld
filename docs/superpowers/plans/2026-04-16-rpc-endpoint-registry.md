# RPC Endpoint Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight shared endpoint gate that cools down hot RPC/API endpoints before fallback traffic saturates the rest of the pool.

**Architecture:** Introduce a shared `RpcEndpointRegistry` that owns endpoint state and availability checks, then route Solana RPC, DLMM, and Jupiter calls through it. Keep selection deterministic and simple: first healthy candidate wins, cooled or saturated candidates are skipped, and total wait time is capped.

**Tech Stack:** TypeScript, Vitest, Node fetch, `@solana/web3.js`

---

### Task 1: Add The Shared Registry

**Files:**
- Create: `src/execution/rpc-endpoint-registry.ts`
- Test: `tests/ts/execution/rpc-endpoint-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover:
- cooling a `429` endpoint and skipping it on the next selection
- respecting endpoint concurrency limits
- throwing a clear exhaustion error when all candidates are unavailable

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/execution/rpc-endpoint-registry.test.ts`
Expected: FAIL because the registry file does not exist yet

- [ ] **Step 3: Write minimal implementation**

Implement:
- endpoint registration
- endpoint state tracking
- `runWithEndpoint()`
- retryable error classification
- lightweight logging

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/execution/rpc-endpoint-registry.test.ts`
Expected: PASS

### Task 2: Wire Solana RPC Through The Registry

**Files:**
- Modify: `src/execution/solana/solana-rpc-client.ts`
- Modify: `src/execution/solana/solana-execution-config.ts`
- Modify: `src/cli/run-solana-execution-main.ts`
- Test: `tests/ts/execution/solana-rpc-config.test.ts`

- [ ] **Step 1: Extend the failing test**

Add a case that uses a shared registry and verifies a `429` write/read endpoint cools down and falls through to the next candidate.

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/execution/solana-rpc-config.test.ts`
Expected: FAIL because `SolanaRpcClient` does not use the shared registry yet

- [ ] **Step 3: Write minimal implementation**

Implement:
- optional `endpointRegistry` constructor wiring
- shared registry execution for read/write RPC calls
- config/env parsing for concurrency and cooldown values
- registry creation and registration in the Solana execution CLI entrypoint

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/execution/solana-rpc-config.test.ts`
Expected: PASS

### Task 3: Wire DLMM Through The Registry

**Files:**
- Modify: `src/execution/solana/meteora-dlmm-client.ts`
- Test: `tests/ts/execution/meteora-dlmm-client.test.ts`

- [ ] **Step 1: Extend the failing test**

Update the DLMM fallback test to use a shared registry and verify a rate-limited primary connection cools down while the secondary connection succeeds.

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/execution/meteora-dlmm-client.test.ts`
Expected: FAIL because the DLMM client does not consult the registry yet

- [ ] **Step 3: Write minimal implementation**

Implement:
- optional `endpointRegistry` constructor wiring
- stable connection identifiers
- shared registry selection for `DLMM.create` and user position reads

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/execution/meteora-dlmm-client.test.ts`
Expected: PASS

### Task 4: Wire Jupiter Through The Registry

**Files:**
- Modify: `src/execution/solana/jupiter-client.ts`
- Test: `tests/ts/execution/jupiter-client.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that sends a `429` response through `JupiterClient`, verifies cooldown is recorded, and verifies the next immediate request fails with `NoRpcEndpointAvailableError` instead of hitting fetch again.

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/execution/jupiter-client.test.ts`
Expected: FAIL because `JupiterClient` currently bypasses the registry

- [ ] **Step 3: Write minimal implementation**

Implement:
- optional `endpointRegistry` constructor wiring
- registry-backed wrapper for quote and swap requests
- timeout to retryable cooldown conversion

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/execution/jupiter-client.test.ts`
Expected: PASS

### Task 5: Run Verification

**Files:**
- Verify only

- [ ] **Step 1: Run targeted execution tests**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/execution/rpc-endpoint-registry.test.ts tests/ts/execution/solana-rpc-config.test.ts tests/ts/execution/meteora-dlmm-client.test.ts tests/ts/execution/jupiter-client.test.ts`
Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Review logs and scope**

Confirm:
- cooldown logs include kind/host/reason
- no unrelated execution paths were changed
- shared registry only wraps external providers
