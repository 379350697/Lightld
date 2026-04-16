# RPC Endpoint Registry Design

**Goal:** Add a lightweight shared gate in front of Solana RPC, DLMM RPC, and Jupiter so `429` and timeout failures cool down hot endpoints before the rest of the pool gets saturated.

## Problem

The codebase already had fallback behavior in individual clients, but each client still made requests directly against its configured endpoints:

- `SolanaRpcClient` looped across read/write URLs after failures
- `MeteoraDlmmClient` used one connection at a time and only fell through after failure
- `JupiterClient` sent requests directly to its API endpoint

This meant the system reacted after a `429` or timeout instead of enforcing a shared precondition before the next request. In practice, one hot endpoint could be hammered repeatedly, and fallback traffic could spill into the rest of the pool.

## Design

Add a shared `RpcEndpointRegistry` that:

- stores endpoint state keyed by URL or connection identifier
- tracks `inFlight`, `cooldownUntil`, `consecutiveFailures`, `lastFailureReason`, and `lastSuccessAt`
- selects the first currently available candidate in configured order
- blocks reuse of endpoints in cooldown or above their concurrency limit
- applies cooldowns for retryable failures
- emits lightweight logs when endpoints cool down, recover, or when no candidate is available

This is intentionally lighter than a full scheduler. It does not implement scoring, token buckets, or weighted balancing. It only adds shared gating, cooldowns, and concurrency caps.

## Scope

Covered by the registry:

- Solana read RPC endpoints
- Solana write RPC endpoints
- DLMM RPC endpoints / connections
- Jupiter API endpoint

Not covered:

- signer HTTP path
- local execution HTTP server
- mirror / SQLite retry logic

## Behavior

### Endpoint state

Each endpoint keeps:

- `url`
- `kinds`
- `maxConcurrency`
- `inFlight`
- `cooldownUntil`
- `consecutiveFailures`
- `lastFailureReason`
- `lastSuccessAt`

### Failure handling

Retryable failures:

- `429` / rate limit text: cooldown `30_000ms`
- timeout / `AbortError`: cooldown `10_000ms`
- `5xx`: cooldown `5_000ms`

Non-retryable failures do not penalize the endpoint:

- Solana protocol/business errors
- Meteora position/business errors
- other hard client errors

### Selection

Selection remains deterministic and simple:

1. filter out cooled endpoints
2. filter out endpoints above concurrency limit
3. choose the first remaining candidate
4. if none are available, wait up to `RPC_ENDPOINT_MAX_WAIT_MS`
5. if still none are available, throw `NoRpcEndpointAvailableError`

## Integration Points

- `src/execution/rpc-endpoint-registry.ts`: shared registry and retryable error classification
- `src/execution/solana/solana-rpc-client.ts`: Solana read/write requests use registry
- `src/execution/solana/meteora-dlmm-client.ts`: DLMM connection selection uses registry
- `src/execution/solana/jupiter-client.ts`: Jupiter requests use registry
- `src/execution/solana/solana-execution-config.ts`: concurrency and cooldown env config
- `src/cli/run-solana-execution-main.ts`: creates one shared registry instance and registers all external endpoints

## Observability

The registry logs only three event types:

- `warn` when an endpoint enters cooldown
- `info` when a previously degraded endpoint succeeds again
- `error` when no endpoint is available, with endpoint snapshots

This keeps noise low while still surfacing the reason for fallback and exhaustion.

## Validation

Validation focuses on:

- endpoint cooldown and skip behavior
- per-endpoint concurrency limits
- Solana client integration with shared registry
- DLMM client integration with shared registry
- Jupiter client integration with shared registry
- typecheck coverage across updated config and constructors
