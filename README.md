# Lightweight Live Runtime

This project is a lightweight Linux-friendly adaptation of the reference strategy system in [`liudx-ref/`](./liudx-ref). It keeps the strategy logic, trading logic, and main live execution flow, while removing:

- shadow runtime
- paper runtime
- Python replay and backtest tooling

The current operating model is:

- personal-use only
- live automation first
- no simulation or paper workflow required
- no whitelist dependency in the live trade path

## Requirements

- Ubuntu 22.04+ or compatible Linux
- Node.js 22 or newer

## Install

```bash
npm install
```

## What Stays The Same

- `new-token-v1` strategy behavior
- `large-pool-v1` strategy behavior
- hard gates around SOL routing and liquidity
- the live trading chain:
  - market snapshot
  - decision context
  - strategy engine
  - quote
  - execution plan
  - live guards
  - sign
  - broadcast
  - journals

## What Was Removed

- `shadow-cycle`
- `paper-cycle`
- `src/paper/`
- `python/`

## Run Tests

```bash
npm test
```

## Type Check

```bash
npm run build
```

## Run A Strategy Cycle

The CLI is intended for Node 22 on Linux and runs directly from TypeScript source:

```bash
npm run run:strategy -- \
  --strategy new-token-v1 \
  --requested-position-sol 0.1 \
  --context-json '{"pool":{"address":"pool-1","liquidityUsd":10000},"token":{"inSession":true,"hasSolRoute":true,"symbol":"SAFE"},"trader":{"hasInventory":true},"route":{"hasSolRoute":true,"expectedOutSol":0.1,"slippageBps":50}}' \
  --json
```

## Live Env

The default runtime mode is `test`, which keeps using local test signer and broadcaster stubs.

To switch the CLI into canary live integration mode, set:

```bash
export LIVE_EXECUTION_MODE=http
export LIVE_QUOTE_URL="https://your-quote-service.example/api"
export LIVE_SIGN_URL="https://your-sign-service.example/api"
export LIVE_BROADCAST_URL="https://your-broadcast-service.example/api"
export LIVE_CONFIRMATION_URL="https://your-confirmation-service.example/api"
export LIVE_ACCOUNT_STATE_URL="https://your-account-state.example/api"
export LIVE_AUTH_TOKEN="replace-me"
```

In `http` mode, the runtime will:

- request a live quote from `LIVE_QUOTE_URL`
- request an external signature from `LIVE_SIGN_URL`
- request broadcast from `LIVE_BROADCAST_URL`
- poll independent on-chain confirmation and finality from `LIVE_CONFIRMATION_URL`
- verify wallet, journal, and token balance reconciliation from `LIVE_ACCOUNT_STATE_URL`

This project still expects those external services to be production-safe and separately secured. It does not embed private-key handling directly.

### Self-Hosted Local Signer

For a single-host Linux deployment, the repo now includes a small local signer service that isolates the private key from the daemon process while keeping the existing `LIVE_SIGN_URL` contract unchanged.

Start it with:

```bash
export LIVE_LOCAL_SIGNER_KEYPAIR_PATH="/opt/lightld/secrets/id.json"
export LIVE_LOCAL_SIGNER_EXPECTED_PUBLIC_KEY="your-wallet-public-key"
export LIVE_LOCAL_SIGNER_AUTH_TOKEN="replace-me"
export LIVE_LOCAL_SIGNER_HOST="127.0.0.1"
export LIVE_LOCAL_SIGNER_PORT="8787"

npm run run:signer
```

Then point the daemon at it:

```bash
export LIVE_SIGN_URL="http://127.0.0.1:8787/sign"
export LIVE_AUTH_TOKEN="replace-me"
```

The bundled signer supports Solana CLI style keypair JSON files such as `~/.config/solana/id.json` and PEM private keys that Node can load. It exposes:

- `GET /health`
- `POST /sign`

The current service signs the `LiveOrderIntent` payload deterministically and returns a base64 signature. It is the private-key isolation layer for the existing runtime contract; it does not yet build or sign Solana transactions directly.

### Self-Hosted Local Execution Sidecar

The repo now also includes a small Ubuntu-friendly execution sidecar that serves the existing contracts for:

- `POST /broadcast`
- `POST /confirmation`
- `GET /account-state`

Start it with:

```bash
export LIVE_LOCAL_EXECUTION_STATE_DIR="/opt/lightld/state/local-execution"
export LIVE_LOCAL_EXECUTION_ACCOUNT_STATE_PATH="/opt/lightld/state/account-state.json"
export LIVE_LOCAL_EXECUTION_EXPECTED_SIGNERS="uBd7VT31LNuba3xpEGrWp8GTbx8AWUk9n3ZfZ6tVkK4"
export LIVE_LOCAL_EXECUTION_AUTH_TOKEN="replace-me"
export LIVE_LOCAL_EXECUTION_HOST="127.0.0.1"
export LIVE_LOCAL_EXECUTION_PORT="8790"
export LIVE_LOCAL_EXECUTION_AUTO_FINALIZE_AFTER_MS="5000"

npm run run:execution
```

Then point the daemon at it:

```bash
export LIVE_BROADCAST_URL="http://127.0.0.1:8790/broadcast"
export LIVE_CONFIRMATION_URL="http://127.0.0.1:8790/confirmation"
export LIVE_ACCOUNT_STATE_URL="http://127.0.0.1:8790/account-state"
export LIVE_AUTH_TOKEN="replace-me"
```

The sidecar verifies the signer signature, records local submissions in a file-backed store, and serves confirmation state based on a lightweight local lifecycle. It accepts swap actions and LP-oriented actions from the runtime contract. `account-state` reads from the JSON file you provide at `LIVE_LOCAL_EXECUTION_ACCOUNT_STATE_PATH`, so you can keep wallet and journal snapshots under your own operational control.

### Confirmation Service Contract

The confirmation service is now part of the real-money safety path. It must accept:

```json
{
  "submissionId": "sub-123",
  "confirmationSignature": "sig-optional"
}
```

And return:

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

Supported `finality` values are:

- `processed`
- `confirmed`
- `finalized`
- `failed`
- `unknown`

The runtime only treats a submission as fully resolved when confirmation reaches `confirmed` or `finalized`, or when the confirmation service returns `failed`.

### Account State Contract

The account-state service is now used for three things in one read per tick:

- SOL reconciliation
- token-level reconciliation
- real inventory detection for strategy context assembly

Recommended payload shape:

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

`walletTokens` is the primary source for `hasInventory`. If `walletTokens` is absent, the runtime can fall back to `journalTokens`, but that is weaker than a real wallet position feed.

## Long-Running Daemon Mode

For a Linux-first single-user deployment, the project now also supports a long-running daemon entrypoint:

```bash
npm run run:daemon -- --strategy new-token-v1
```

Recommended environment variables:

```bash
export LIVE_STATE_DIR="/opt/lightld/state"
export LIVE_JOURNAL_DIR="/opt/lightld/tmp/journals"
export LIVE_DAEMON_TICK_INTERVAL_MS="30000"
export LIVE_REQUESTED_POSITION_SOL="0.1"
export LIVE_TRADER_WALLET="your-wallet"
export LIVE_METEORA_PAGE_SIZE="25"
export LIVE_METEORA_SORT_BY="tvl:desc"
export LIVE_METEORA_FILTER_BY="is_blacklisted=false"
export LIVE_ALERT_WEBHOOK_URL="https://hooks.example/bot"
export LIVE_ALERT_AUTH_TOKEN="replace-me"
export LIVE_DB_MIRROR_ENABLED="true"
export LIVE_DB_MIRROR_PATH="/opt/lightld/state/lightld-observability.sqlite"
export LIVE_DB_MIRROR_QUEUE_CAPACITY="1000"
export LIVE_DB_MIRROR_BATCH_SIZE="64"
export LIVE_DB_MIRROR_FLUSH_INTERVAL_MS="250"
export LIVE_DB_MIRROR_MAX_RETRIES="2"
export LIVE_DB_MIRROR_COOLDOWN_MS="60000"
export LIVE_DB_MIRROR_FAILURE_THRESHOLD="3"
export LIVE_DB_MIRROR_RETENTION_DAYS="30"
export LIVE_DB_MIRROR_PRUNE_INTERVAL_MS="1800000"
export LIVE_HOUSEKEEPING_INTERVAL_MS="1800000"
export LIVE_DECISION_AUDIT_RETENTION_DAYS="14"
export LIVE_QUOTES_RETENTION_DAYS="7"
export LIVE_ORDER_RETENTION_DAYS="90"
export LIVE_FILL_RETENTION_DAYS="90"
export LIVE_INCIDENT_RETENTION_DAYS="30"
export GMGN_CACHE_MAX_ENTRIES="5000"
```

The daemon keeps the process lightweight by staying single-process, but it adds:

- durable runtime snapshots under `state/`
- dependency health tracking
- pending submission recovery gating
- independent confirmation polling with finality checks
- ingest-backed cycle input assembly from Meteora, Pump, and GMGN
- token-level reconciliation and real inventory-aware context assembly
- an optional SQLite mirror for fast operational queries
- runtime mode transitions such as `healthy`, `degraded`, `circuit_open`, `flatten_only`, and `recovering`
- a machine-readable health snapshot

When the daemon runs, it no longer needs a hand-written `context`. It now builds one each tick from:

- Meteora pools as the primary candidate source
- Pump events to infer holders and symbol freshness
- GMGN trader metadata when `LIVE_TRADER_WALLET` is configured
- account-state holdings and fills to infer inventory and reconcile execution state

The assembled context then flows through the unchanged main chain:

- ingest
- build decision context
- strategy engine
- quote
- execution plan
- live guards
- sign
- broadcast
- journals

You can also override the ingest inputs per process start:

```bash
npm run run:daemon -- \
  --strategy new-token-v1 \
  --trader-wallet your-wallet \
  --requested-position-sol 0.1 \
  --meteora-page-size 25 \
  --meteora-sort-by tvl:desc \
  --meteora-filter-by "is_blacklisted=false"
```

`LIVE_TRADER_WALLET` is optional but still useful for GMGN enrichment. `hasInventory` no longer depends on Pump wallet flow. It now comes from the account-state service, so if `walletTokens` already reflects the real wallet position, the strategy can detect inventory even without `LIVE_TRADER_WALLET`.

## Runtime Modes

- `healthy`
  normal live operation
- `degraded`
  dependencies are shaky; the daemon stays active and keeps tracking risk
- `circuit_open`
  new exposure-increasing actions such as `deploy` and `add-lp` are blocked
- `flatten_only`
  only reduction paths such as `dca-out` and `withdraw-lp` are allowed
- `paused`
  operator pause mode
- `recovering`
  restart or cooldown validation mode before normal trading resumes

## Health And Status

The daemon writes a lightweight health snapshot to:

```bash
state/health.json
```

You can inspect it directly:

```bash
cat state/health.json
```

Or use the status CLI:

```bash
npm run show:status -- --state-root-dir state
```

If the SQLite mirror is enabled and healthy, `show:status` will also include recent incidents and recent order summaries from the mirror. If the mirror is unavailable, the CLI falls back to the file-backed health snapshot automatically.

## Journals

Live runtime journals are written to `tmp/journals/`:

- `*-decision-audit-YYYY-MM-DD.jsonl`
- `*-quotes-YYYY-MM-DD.jsonl`
- `*-live-orders-YYYY-MM-DD.jsonl`
- `*-live-fills-YYYY-MM-DD.jsonl`
- `*-live-incidents-YYYY-MM-DD.jsonl`

Each entry is compacted before write, so empty fields are dropped automatically. The runtime now records per-cycle summary fields such as `cycleId`, `stage`, `poolAddress`, `tokenSymbol`, `requestedPositionSol`, quote summary, confirmation status, and reconciliation delta where applicable.

The daemon also keeps storage bounded automatically:

- journals rotate daily
- housekeeping removes expired journal shards on a timer
- default retention is `7d` quotes, `14d` decision audit, `30d` incidents, `90d` orders/fills
- the GMGN safety cache is swept and capped at `5000` entries by default

## SQLite Mirror

The runtime can optionally maintain a lightweight SQLite mirror under `state/`, intended for:

- faster order and incident lookup
- lightweight unattended troubleshooting
- status CLI enrichment without scanning raw JSONL

Important behavior:

- JSONL and `state/*.json` remain the truth source
- SQLite is only an asynchronous mirror
- mirror failures never block the trading path
- when the mirror degrades, health output will include mirror state, queue depth, and dropped event counts
- old mirror rows are pruned automatically, with `30d` retention by default

The mirror stores structured summaries for:

- cycle runs
- orders
- fills
- reconciliations
- incidents
- runtime snapshots

The implementation uses Node 22's built-in `node:sqlite` API in `WAL` mode. That API currently emits an experimental warning on startup, but the runtime itself is fully validated through tests and type checks.

## Durable State

The long-running runtime writes lightweight JSON snapshot files under `state/`:

- `runtime-state.json`
- `dependency-health.json`
- `pending-submission.json`
- `position-state.json`
- `health.json`

`pending-submission.json` is important for restart safety. If the previous run left a submission in `submitted` or `unknown` state, new unsafe submissions are blocked until recovery clears the state.

Recovery now checks both:

- the independent confirmation service for updated status and finality
- the account-state `fills` stream for a matching `submissionId` or `confirmationSignature`

If neither path resolves the submission before the local timeout window expires, the daemon keeps blocking new submissions and escalates runtime mode toward `circuit_open`.

## Ingest Sources

The lightweight build still exposes the ingest adapters for Meteora, Pump, and GMGN. Their default endpoints can be overridden with:

- `METEORA_POOLS_URL`
- `PUMP_TRADES_URL`
- `GMGN_TRADER_URL_BASE`

The daemon only requires Meteora to be configured. Pump and GMGN are optional enrichers:

- if `PUMP_TRADES_URL` is unset and still points at the placeholder endpoint, the daemon skips Pump enrichment
- if `GMGN_TRADER_URL_BASE` is unset or `LIVE_TRADER_WALLET` is empty, the daemon skips GMGN enrichment
- if no eligible candidate survives filtering, the daemon emits a safe fallback context that resolves to `hold` instead of crashing the process

### Meteora Constraints

The Meteora DLMM adapter validates request params before sending traffic:

- `page` must be an integer `>= 1`
- `page_size` must be an integer between `1` and `1000`
- `sort_by` accepts documented DLMM pool fields including `volume_*`, `fee_*`, `fee_tvl_ratio_*`, `apr_*`, `tvl`, `fee_pct`, `bin_step`, `pool_created_at`, and `farm_apy`
- `filter_by` accepts documented numeric, boolean, and text clauses, and normalizes whitespace around operators
- `timeframe` is limited to `5m`, `30m`, `1h`, `2h`, `4h`, `12h`, `24h`
- `start_time` and `end_time` must be non-negative Unix timestamps, and `start_time` cannot be greater than `end_time`

The adapter also exports Meteora API constants so callers can align schedulers and throttling with the current documented limit of `30` requests per second.

## Linux Service

A sample `systemd` unit is included at [lightld.service](/D:/codex2/Lightld/ops/systemd/lightld.service).
A matching local signer unit is included at [lightld-signer.service](/D:/codex2/Lightld/ops/systemd/lightld-signer.service).
A matching execution sidecar unit is included at [lightld-execution.service](/D:/codex2/Lightld/ops/systemd/lightld-execution.service).

The recommended flow is:

1. place the project under `/opt/lightld`
2. put env vars in `/etc/lightld.env`
3. enable the `systemd` unit
4. inspect runtime health through `state/health.json` or `npm run show:status`

The longer operator guide lives at [long-running-live-runtime.md](/D:/codex2/Lightld/docs/runbooks/long-running-live-runtime.md).

## Verification

```bash
npm test
npm run build
```
