#!/usr/bin/env bash
set -euo pipefail

ROLE="$1"
ROOT="$2"
STATE_ROOT="$3"
JOURNAL_ROOT="$4"

cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
source "$ROOT/scripts/lightld-process-records.sh"

export LIGHTLD_RUN_MODE=live
export LIGHTLD_EXECUTION_MODE=live
export SOLANA_EXECUTION_DRY_RUN=false
export LIVE_STATE_DIR="$STATE_ROOT"
export LIVE_JOURNAL_DIR="$JOURNAL_ROOT"
export LIVE_CANDIDATE_POOL_DB_PATH="$STATE_ROOT/lightld-candidate-pool.sqlite"
export LIVE_DB_MIRROR_PATH="$STATE_ROOT/lightld-observability.sqlite"
export SOLANA_EXECUTION_STATE_DIR="$STATE_ROOT/solana-execution"
export SOLANA_MAX_OUTPUT_SOL="${SOLANA_MAX_OUTPUT_SOL:-0.05}"
export JITO_TIP_LAMPORTS="${JITO_TIP_LAMPORTS:-25000}"
export SOLANA_DEFAULT_SLIPPAGE_BPS="${SOLANA_DEFAULT_SLIPPAGE_BPS:-100}"
export LIVE_MAX_SINGLE_ORDER_SOL="${LIVE_MAX_SINGLE_ORDER_SOL:-0.05}"
export LIVE_MAX_DAILY_SPEND_SOL="${LIVE_MAX_DAILY_SPEND_SOL:-0.2}"
export LIVE_EXECUTION_MODE=http
export LIVE_LOCAL_SIGNER_PORT="${LIVE_LOCAL_SIGNER_PORT:-8787}"
export SOLANA_EXECUTION_PORT="${SOLANA_EXECUTION_PORT:-8791}"
export GMGN_SAFETY_PORT="${GMGN_SAFETY_PORT:-8898}"
export GMGN_SAFETY_URL="${GMGN_SAFETY_URL:-http://127.0.0.1:$GMGN_SAFETY_PORT/safety}"
export LIVE_SIGN_URL="http://127.0.0.1:$LIVE_LOCAL_SIGNER_PORT/sign"
export LIVE_QUOTE_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/quote"
export LIVE_BROADCAST_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/broadcast"
export LIVE_CONFIRMATION_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/confirmation"
export LIVE_ACCOUNT_STATE_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/account-state"

record_dir="$(lightld_process_record_dir "$ROOT" "$STATE_ROOT")"
mkdir -p "$record_dir"
exec 8> "$record_dir/$ROLE.lock"
if ! flock -n 8; then
  echo "A Lightld '$ROLE' process is already running for StateRoot '$STATE_ROOT'" >&2
  exit 1
fi

case "$ROLE" in
  signer) exec npm run run:signer ;;
  gmgn) exec "${GMGN_PYTHON_BIN:-python3}" scripts/gmgn-token-safety-server.py ;;
  execution) exec npm run run:solana-execution ;;
  candidate) exec npm run run:candidate-worker -- --strategy new-token-v1 --state-root-dir "$STATE_ROOT" --db-path "$LIVE_CANDIDATE_POOL_DB_PATH" ;;
  daemon)
    while true; do
      npm run run:daemon -- --strategy new-token-v1 --state-root-dir "$STATE_ROOT" --journal-root-dir "$JOURNAL_ROOT" || true
      echo "[Lightld Daemon] exited; restarting in 5 seconds" >&2
      sleep 5
    done
    ;;
  *) echo "Unknown live component role: $ROLE" >&2; exit 1 ;;
esac
