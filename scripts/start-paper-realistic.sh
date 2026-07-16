#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIGHTLD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_ROOT="${LIVE_STATE_DIR:-$ROOT/state-paper-realistic}"
JOURNAL_ROOT="${LIVE_JOURNAL_DIR:-$ROOT/tmp/paper-realistic-journals}"
MAX_ACTIVE_POSITIONS="${LIVE_MAX_ACTIVE_POSITIONS:-100000}"
TICK_INTERVAL_MS="${LIVE_DAEMON_TICK_INTERVAL_MS:-10000}"
HOT_TICK_INTERVAL_MS="${LIVE_DAEMON_HOT_TICK_INTERVAL_MS:-2000}"
REQUESTED_POSITION_SOL="${LIVE_REQUESTED_POSITION_SOL:-1}"

cd "$ROOT"
source "$ROOT/scripts/load-env.sh"

# Reassert paper isolation after dotenv loading so local files cannot turn this launcher live.
export LIGHTLD_RUN_MODE=mechanical-soak
export LIGHTLD_EXECUTION_MODE=mechanical-soak
export SOLANA_EXECUTION_DRY_RUN=true
export LIVE_EXECUTION_MODE=http
export LIVE_STATE_DIR="$STATE_ROOT"
export LIVE_JOURNAL_DIR="$JOURNAL_ROOT"
export SOLANA_EXECUTION_STATE_DIR="$STATE_ROOT/solana-execution"
export LIVE_CANDIDATE_POOL_DB_PATH="$STATE_ROOT/lightld-candidate-pool.sqlite"
export LIVE_DB_MIRROR_PATH="$STATE_ROOT/lightld-observability.sqlite"
export LIVE_QUOTE_URL="${LIVE_QUOTE_URL:-http://127.0.0.1:8791/quote}"
export LIVE_SIGN_URL="${LIVE_SIGN_URL:-http://127.0.0.1:8788/sign}"
export LIVE_BROADCAST_URL="${LIVE_BROADCAST_URL:-http://127.0.0.1:8791/broadcast}"
export LIVE_CONFIRMATION_URL="${LIVE_CONFIRMATION_URL:-http://127.0.0.1:8791/confirmation}"
export LIVE_ACCOUNT_STATE_URL="${LIVE_ACCOUNT_STATE_URL:-http://127.0.0.1:8791/account-state}"
export LIVE_REQUESTED_POSITION_SOL="$REQUESTED_POSITION_SOL"
export LIVE_DISABLE_DYNAMIC_POSITION_SIZING=true
export LIVE_IGNORE_POSITION_SOL_LIMIT=true
export LIVE_IGNORE_SPENDING_LIMITS=true
export LIVE_MAX_ACTIVE_POSITIONS="$MAX_ACTIVE_POSITIONS"
export LIVE_DAEMON_TICK_INTERVAL_MS="$TICK_INTERVAL_MS"
export LIVE_DAEMON_HOT_TICK_INTERVAL_MS="$HOT_TICK_INTERVAL_MS"
export LIVE_LOCAL_SIGNER_MAX_OUTPUT_SOL=1000000
export LIVE_LOCAL_EXECUTION_MAX_OUTPUT_SOL=1000000
export SOLANA_MAX_OUTPUT_SOL=1000000

mkdir -p "$STATE_ROOT" "$JOURNAL_ROOT" "$ROOT/logs"

pids=()
cleanup() {
  if ((${#pids[@]})); then kill "${pids[@]}" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

restart_worker() {
  local role="$1"
  shift
  while true; do
    "$@" >> "$ROOT/logs/paper-$role.log" 2>&1 || true
    sleep 5
  done
}

npm run run:signer >> "$ROOT/logs/paper-signer.log" 2>&1 & pids+=("$!")
npm run run:solana-execution >> "$ROOT/logs/paper-execution.log" 2>&1 & pids+=("$!")
restart_worker candidate npm run run:candidate-worker -- --strategy new-token-v1 --state-root-dir "$STATE_ROOT" --db-path "$LIVE_CANDIDATE_POOL_DB_PATH" & pids+=("$!")
restart_worker research npm run run:research-worker -- --state-root-dir "$STATE_ROOT" & pids+=("$!")
npm run run:daemon -- --strategy new-token-v1 --state-root-dir "$STATE_ROOT" --journal-root-dir "$JOURNAL_ROOT" --max-active-positions "$MAX_ACTIVE_POSITIONS" --tick-interval-ms "$TICK_INTERVAL_MS" --hot-tick-interval-ms "$HOT_TICK_INTERVAL_MS" >> "$ROOT/logs/paper-daemon.log" 2>&1 & pids+=("$!")

printf '{"mode":"mechanical-soak","stateRoot":"%s","pids":[%s]}\n' "$STATE_ROOT" "$(IFS=,; echo "${pids[*]}")"
wait
