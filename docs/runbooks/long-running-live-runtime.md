# Long-Running Live Runtime Runbook

## Overview

This project can now run as a single long-running Linux process for one-person operation. The runtime is still live-only, but it now adds:

- durable state snapshots under `state/`
- pending submission recovery gating
- runtime modes such as `healthy`, `degraded`, `circuit_open`, `flatten_only`, and `recovering`
- a lightweight health snapshot
- a status CLI

## Recommended Linux Layout

Use a single service account and one working directory:

- `/opt/lightld`
- `/opt/lightld/state`
- `/opt/lightld/tmp/journals`

Keep environment variables in `/etc/lightld.env`.

## Required Environment

At minimum:

```bash
LIVE_EXECUTION_MODE=http
LIVE_QUOTE_URL=https://your-quote-service.example/api
LIVE_SIGN_URL=https://your-sign-service.example/api
LIVE_BROADCAST_URL=https://your-broadcast-service.example/api
LIVE_CONFIRMATION_URL=https://your-confirmation-service.example/api
LIVE_ACCOUNT_STATE_URL=https://your-account-service.example/api
```

Optional:

```bash
LIVE_AUTH_TOKEN=replace-me
LIVE_STATE_DIR=/opt/lightld/state
LIVE_JOURNAL_DIR=/opt/lightld/tmp/journals
LIVE_DAEMON_TICK_INTERVAL_MS=30000
LIVE_REQUESTED_POSITION_SOL=0.1
LIVE_WHITELIST=SAFE,ABC
LIVE_TRADER_WALLET=your-wallet
LIVE_METEORA_PAGE_SIZE=25
LIVE_METEORA_SORT_BY=tvl:desc
LIVE_METEORA_FILTER_BY=is_blacklisted=false
LIVE_ALERT_WEBHOOK_URL=https://hooks.example/bot
LIVE_ALERT_AUTH_TOKEN=replace-me
LIVE_DB_MIRROR_ENABLED=true
LIVE_DB_MIRROR_PATH=/opt/lightld/state/lightld-observability.sqlite
LIVE_DB_MIRROR_QUEUE_CAPACITY=1000
LIVE_DB_MIRROR_BATCH_SIZE=64
LIVE_DB_MIRROR_FLUSH_INTERVAL_MS=250
LIVE_DB_MIRROR_MAX_RETRIES=2
LIVE_DB_MIRROR_COOLDOWN_MS=60000
LIVE_DB_MIRROR_FAILURE_THRESHOLD=3
```

## Local Signer Option

If you want to keep the runtime and private key handling separated on the same Linux host, run the bundled local signer service:

```bash
LIVE_LOCAL_SIGNER_KEYPAIR_PATH=/opt/lightld/secrets/id.json
LIVE_LOCAL_SIGNER_EXPECTED_PUBLIC_KEY=your-wallet-public-key
LIVE_LOCAL_SIGNER_AUTH_TOKEN=replace-me
LIVE_LOCAL_SIGNER_HOST=127.0.0.1
LIVE_LOCAL_SIGNER_PORT=8787
```

Start it with:

```bash
npm run run:signer
```

And point the daemon to it:

```bash
LIVE_SIGN_URL=http://127.0.0.1:8787/sign
LIVE_AUTH_TOKEN=replace-me
```

The service exposes:

- `GET /health`
- `POST /sign`

It signs the current `LiveOrderIntent` payload with the locally stored keypair and returns the existing `LIVE_SIGN_URL` response shape. It is not yet a Solana transaction builder; keep broadcaster, confirmation, and account-state services separate.

## Local Execution Sidecar Option

For a single Ubuntu host, the repo also includes a local execution sidecar that serves `broadcast`, `confirmation`, and `account-state` over HTTP.

Recommended environment:

```bash
LIVE_LOCAL_EXECUTION_STATE_DIR=/opt/lightld/state/local-execution
LIVE_LOCAL_EXECUTION_ACCOUNT_STATE_PATH=/opt/lightld/state/account-state.json
LIVE_LOCAL_EXECUTION_EXPECTED_SIGNERS=uBd7VT31LNuba3xpEGrWp8GTbx8AWUk9n3ZfZ6tVkK4
LIVE_LOCAL_EXECUTION_AUTH_TOKEN=replace-me
LIVE_LOCAL_EXECUTION_HOST=127.0.0.1
LIVE_LOCAL_EXECUTION_PORT=8790
LIVE_LOCAL_EXECUTION_AUTO_FINALIZE_AFTER_MS=5000
```

Start it with:

```bash
npm run run:execution
```

And point the daemon to it:

```bash
LIVE_BROADCAST_URL=http://127.0.0.1:8790/broadcast
LIVE_CONFIRMATION_URL=http://127.0.0.1:8790/confirmation
LIVE_ACCOUNT_STATE_URL=http://127.0.0.1:8790/account-state
LIVE_AUTH_TOKEN=replace-me
```

This sidecar is intentionally lightweight:

- it verifies the signature produced by the local signer
- it stores submissions under the configured state directory
- it serves confirmation from that local store after a small configurable finalize delay
- it reads account snapshots from `LIVE_LOCAL_EXECUTION_ACCOUNT_STATE_PATH`

It gives you a self-hosted Ubuntu service boundary for the current contracts, but it is still not a real Solana transaction sender.

## Ingest-Backed Context Assembly

The daemon now builds `DecisionContextInput` automatically on every tick:

1. pull candidate pools from Meteora
2. enrich token metadata from Pump when available
3. enrich trader labels and pnl from GMGN when `LIVE_TRADER_WALLET` is set
4. read real wallet and journal balances from the account-state service
5. pick one candidate for the active strategy
6. pass the assembled context into the normal live cycle

Recommended operator settings:

- always set `LIVE_WHITELIST` for symbols you actually want to trade
- keep the account-state service populated with `walletTokens`, because that is now the primary source for `hasInventory`
- set `LIVE_TRADER_WALLET` when you want GMGN trader enrichment; it is no longer required for inventory detection
- keep `LIVE_METEORA_PAGE_SIZE` small, usually `10` to `25`, to reduce per-tick bandwidth

If Pump or GMGN are still on placeholder endpoints, the daemon skips those enrichments instead of failing the whole tick.

## Confirmation Service Contract

The daemon now requires an independent confirmation service. It receives:

```json
{
  "submissionId": "sub-123",
  "confirmationSignature": "sig-optional"
}
```

And should return:

```json
{
  "submissionId": "sub-123",
  "confirmationSignature": "sig-optional",
  "status": "submitted",
  "finality": "processed",
  "checkedAt": "2026-03-22T00:00:00.000Z",
  "reason": ""
}
```

The runtime only clears pending submission state automatically when:

- `status=confirmed` and `finality=confirmed|finalized`
- `status=failed`

Any other result keeps the submission in recovery tracking.

## Account State Contract

The account-state service is used once per tick and should return enough data for:

- SOL reconciliation
- token-level reconciliation
- real inventory detection
- fill-based recovery matching

Recommended payload:

```json
{
  "walletSol": 1.25,
  "journalSol": 1.25,
  "walletTokens": [
    { "mint": "token-mint", "symbol": "SAFE", "amount": 1200 }
  ],
  "journalTokens": [
    { "mint": "token-mint", "symbol": "SAFE", "amount": 1200 }
  ],
  "fills": [
    {
      "submissionId": "sub-123",
      "confirmationSignature": "sig-optional",
      "mint": "token-mint",
      "symbol": "SAFE",
      "side": "buy",
      "amount": 1200,
      "recordedAt": "2026-03-22T00:00:00.000Z"
    }
  ]
}
```

If `walletTokens` is missing, the runtime can fall back to `journalTokens` for inventory hints, but that weakens the safety model.

## Start The Daemon

```bash
npm run run:daemon -- --strategy new-token-v1
```

Or use the packaged `systemd` units under [lightld.service](/D:/codex2/Lightld/ops/systemd/lightld.service), [lightld-signer.service](/D:/codex2/Lightld/ops/systemd/lightld-signer.service), and [lightld-execution.service](/D:/codex2/Lightld/ops/systemd/lightld-execution.service).

## Check Status

Read the machine-readable snapshot:

```bash
cat state/health.json
```

Or use the status CLI:

```bash
npm run show:status -- --state-root-dir state
```

If the SQLite mirror is enabled, the status CLI will try to show recent incidents and recent orders from the mirror. If the mirror is unavailable, the CLI automatically falls back to the file-backed health report.

## SQLite Mirror

The daemon can run with an optional local SQLite mirror. Its purpose is to improve unattended operations without becoming part of trade safety.

What it mirrors:

- cycle summaries
- order lifecycle summaries
- fill summaries
- reconciliation summaries
- runtime snapshots
- incidents

What it does not do:

- it does not gate trading
- it is not the recovery truth source
- it does not replace JSONL journals

Recommended Linux settings:

- keep the mirror file under `/opt/lightld/state`
- keep `LIVE_DB_MIRROR_ENABLED=true` only on hosts where local disk is stable
- leave the queue and batch defaults small unless you observe sustained lag

The mirror uses Node 22 built-in SQLite in `WAL` mode. You may see a one-time experimental warning from Node on startup. That warning is expected with the current API surface.

## Runtime Modes

- `healthy`
  normal live operation
- `degraded`
  dependencies are shaky; new risk is still allowed but caution is increasing
- `circuit_open`
  new deploy actions are blocked
- `flatten_only`
  only reduction paths are allowed
- `paused`
  operator pause
- `recovering`
  post-failure or post-restart validation mode

## Pending Submission Recovery

The runtime writes `state/pending-submission.json` for unresolved or unknown submissions.

If this file reflects `submitted` or `unknown` confirmation state, the runtime will refuse unsafe new submissions until recovery checks clear the state.

Recovery follows this order:

1. poll the independent confirmation service
2. look for a matching fill in the account-state payload
3. keep blocking if the outcome is still unresolved
4. escalate to `circuit_open` if the local timeout window expires

This is intentionally conservative. The daemon prefers blocking over risking a duplicate live order.

## Pause And Resume

This build does not yet include a dedicated pause CLI. The recommended operator action is:

1. stop the service
2. inspect `state/health.json` and journals
3. clear or update durable state only after confirming the last submission outcome
4. restart the service

## Alerting

If `LIVE_ALERT_WEBHOOK_URL` is configured, the daemon will emit alerts on mode changes into:

- `circuit_open`
- `flatten_only`

## Journal And Log Handling

- JSONL journals remain under `tmp/journals/`
- the SQLite mirror is only a query cache over structured summaries
- process logs should be collected by `journald`
- configure system log retention and journal cleanup so disk usage remains bounded

## Recovery Expectations

After a restart:

1. the daemon reloads runtime state
2. pending submission state is checked against confirmation and account fills
3. unresolved or unknown submissions block unsafe new execution
4. token and SOL reconciliation are re-evaluated
5. health output is refreshed before normal operation resumes
