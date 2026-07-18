#!/usr/bin/env bash
set -euo pipefail

ROLE="$1"
ROOT="$2"
STATE_ROOT="$3"
JOURNAL_ROOT="$4"
STRATEGY="$5"
MAX_ACTIVE_POSITIONS="$6"
TICK_INTERVAL_MS="$7"
HOT_TICK_INTERVAL_MS="$8"

cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
source "$ROOT/scripts/lightld-process-records.sh"

export LIGHTLD_RUN_MODE=mechanical-soak
export LIGHTLD_EXECUTION_MODE=mechanical-soak
export SOLANA_EXECUTION_DRY_RUN=true
export LIVE_LOCAL_SIGNER_PORT="${LIVE_LOCAL_SIGNER_PORT:-8787}"
export SOLANA_EXECUTION_PORT="${SOLANA_EXECUTION_PORT:-8791}"
export GMGN_SAFETY_PORT="${GMGN_SAFETY_PORT:-8898}"
export GMGN_SAFETY_URL="${GMGN_SAFETY_URL:-http://127.0.0.1:$GMGN_SAFETY_PORT/safety}"
export SOLANA_MAX_OUTPUT_SOL="${SOLANA_MAX_OUTPUT_SOL:-0.05}"
export JITO_TIP_LAMPORTS="${JITO_TIP_LAMPORTS:-25000}"
export SOLANA_DEFAULT_SLIPPAGE_BPS="${SOLANA_DEFAULT_SLIPPAGE_BPS:-100}"
export LIVE_MAX_SINGLE_ORDER_SOL="${LIVE_MAX_SINGLE_ORDER_SOL:-0.05}"
export LIVE_MAX_DAILY_SPEND_SOL="${LIVE_MAX_DAILY_SPEND_SOL:-0.2}"
export LIVE_EXECUTION_MODE=http
export LIVE_STATE_DIR="$STATE_ROOT"
export LIVE_JOURNAL_DIR="$JOURNAL_ROOT"
export SOLANA_EXECUTION_STATE_DIR="$STATE_ROOT/solana-execution"
export LIVE_CANDIDATE_POOL_DB_PATH="$STATE_ROOT/lightld-candidate-pool.sqlite"
export LIVE_DB_MIRROR_PATH="$STATE_ROOT/lightld-observability.sqlite"
export LIVE_QUOTE_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/quote"
export LIVE_SIGN_URL="http://127.0.0.1:$LIVE_LOCAL_SIGNER_PORT/sign"
export LIVE_BROADCAST_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/broadcast"
export LIVE_CONFIRMATION_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/confirmation"
export LIVE_ACCOUNT_STATE_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/account-state"
export LIVE_MAX_ACTIVE_POSITIONS="$MAX_ACTIVE_POSITIONS"
export LIVE_DAEMON_TICK_INTERVAL_MS="$TICK_INTERVAL_MS"
export LIVE_DAEMON_HOT_TICK_INTERVAL_MS="$HOT_TICK_INTERVAL_MS"

record_dir="$(lightld_process_record_dir "$ROOT" "$STATE_ROOT")"
mkdir -p "$record_dir"
exec 8> "$record_dir/$ROLE.lock"
if ! flock -n 8; then
  echo "A Lightld '$ROLE' process is already running for StateRoot '$STATE_ROOT'" >&2
  exit 1
fi

restart_worker() {
  local role="$1"
  shift
  while true; do
    "$@" || true
    echo "[PaperRealistic] $role exited; restarting in 5 seconds" >&2
    sleep 5
  done
}

case "$ROLE" in
  signer) exec npm run run:signer ;;
  gmgn) restart_worker gmgn "${GMGN_PYTHON_BIN:-python3}" scripts/gmgn-token-safety-server.py ;;
  execution) exec npm run run:solana-execution ;;
  candidate) restart_worker candidate npm run run:candidate-worker -- --strategy "$STRATEGY" --state-root-dir "$STATE_ROOT" --db-path "$LIVE_CANDIDATE_POOL_DB_PATH" ;;
  research) restart_worker research npm run run:research-worker -- --state-root-dir "$STATE_ROOT" ;;
  daemon) restart_worker daemon npm run run:daemon -- --strategy "$STRATEGY" --state-root-dir "$STATE_ROOT" --journal-root-dir "$JOURNAL_ROOT" --max-active-positions "$MAX_ACTIVE_POSITIONS" --tick-interval-ms "$TICK_INTERVAL_MS" --hot-tick-interval-ms "$HOT_TICK_INTERVAL_MS" ;;
  *) echo "Unknown paper component role: $ROLE" >&2; exit 1 ;;
esac
