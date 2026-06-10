# Bug Card: Solana Execution Boundary

## Stable Fingerprints

- `solana.execution.signed_intent_unverified.idempotency_missing`
- `ops.solana_execution.production_sidecar_missing_runbook`

## Current Effective Rule

True Solana execution must treat `/broadcast` as a money-moving boundary: bearer auth is not sufficient. Signed intent verification and idempotency replay protection are required before RPC broadcast.

## Source / Business Semantics

The daemon signs order intent; the execution sidecar signs and broadcasts Solana transactions. The sidecar must prove the daemon intent is authentic and avoid duplicate transaction submission on request retries.

## Attempts Ledger

| Date | Attempt | Evidence | Result |
| --- | --- | --- | --- |
| 2026-06-11 | Initial audit | `solana-execution-server` lacked verification/store while local sidecar had both | Fixed local; deploy pending. |
| 2026-06-11 | Closure review | Sequential idempotency still allowed concurrent duplicate broadcasts and post-send/unknown-send persistence gaps | Added pending reservation, same-key serialization, stale-pending fail-closed tests, and RPC-send unknown-state retention. |

## Recurrences

| Date | Cluster | Trigger | Result |
| --- | --- | --- | --- |
| 2026-06-11 | CL-001 | Mainnet readiness review | Fixed local; deploy pending |
| 2026-06-11 | CL-003 | Ops artifact review | Fixed local; deploy pending |

## Regression Harness

- Solana `/broadcast` rejects invalid signatures before RPC calls.
- Duplicate idempotency returns stored result without `sendRawTransaction`.
- Same idempotency key with different signed intent is rejected.
- Concurrent duplicate idempotency requests serialize before Solana RPC broadcast.
- Existing pending reservations fail closed without rebroadcasting.
- RPC send attempts that fail before returning a signature keep the key pending to avoid unsafe duplicate retries.

## Next Recurrence Checklist

- Check both local and Solana sidecars when signer contract changes.
- Confirm production docs name the true Solana sidecar, not only local simulation.
- Require local green plus deploy evidence before marking deployed.
