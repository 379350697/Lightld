#!/usr/bin/env bash
set -euo pipefail

if [[ "${LIGHTLD_LIVE_CONFIRM:-}" != "I_UNDERSTAND_MAINNET" ]]; then
  echo "Set LIGHTLD_LIVE_CONFIRM=I_UNDERSTAND_MAINNET to confirm mainnet live trading" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
source "$ROOT/scripts/lightld-process-records.sh"

export LIGHTLD_RUN_MODE=live
export LIGHTLD_EXECUTION_MODE=live
export SOLANA_EXECUTION_DRY_RUN=false
export LIVE_LOCAL_SIGNER_PORT="${LIVE_LOCAL_SIGNER_PORT:-8787}"
export SOLANA_EXECUTION_PORT="${SOLANA_EXECUTION_PORT:-8791}"
export GMGN_SAFETY_PORT="${GMGN_SAFETY_PORT:-8898}"
export GMGN_SAFETY_URL="${GMGN_SAFETY_URL:-http://127.0.0.1:$GMGN_SAFETY_PORT/safety}"
export SOLANA_MAX_OUTPUT_SOL="${SOLANA_MAX_OUTPUT_SOL:-0.05}"
export LIVE_MAX_SINGLE_ORDER_SOL="${LIVE_MAX_SINGLE_ORDER_SOL:-0.05}"
export LIVE_MAX_DAILY_SPEND_SOL="${LIVE_MAX_DAILY_SPEND_SOL:-0.2}"
export LIVE_EXECUTION_MODE=http

STATE_ROOT="$(lightld_resolve_path "$ROOT" "${LIVE_STATE_DIR:-state}")"
JOURNAL_ROOT="$(lightld_resolve_path "$ROOT" "${LIVE_JOURNAL_DIR:-tmp/journals}")"
mkdir -p "$STATE_ROOT" "$JOURNAL_ROOT" "$ROOT/logs"
STATE_ROOT="$(cd "$STATE_ROOT" && pwd -P)"
JOURNAL_ROOT="$(cd "$JOURNAL_ROOT" && pwd -P)"
export LIVE_STATE_DIR="$STATE_ROOT"
export LIVE_JOURNAL_DIR="$JOURNAL_ROOT"
export LIVE_CANDIDATE_POOL_DB_PATH="$STATE_ROOT/lightld-candidate-pool.sqlite"
export LIVE_DB_MIRROR_PATH="$STATE_ROOT/lightld-observability.sqlite"
export SOLANA_EXECUTION_STATE_DIR="$STATE_ROOT/solana-execution"
export LIVE_SIGN_URL="http://127.0.0.1:$LIVE_LOCAL_SIGNER_PORT/sign"
export LIVE_QUOTE_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/quote"
export LIVE_BROADCAST_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/broadcast"
export LIVE_CONFIRMATION_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/confirmation"
export LIVE_ACCOUNT_STATE_URL="http://127.0.0.1:$SOLANA_EXECUTION_PORT/account-state"

if ! command -v flock >/dev/null 2>&1 || ! command -v setsid >/dev/null 2>&1; then
  echo "Live launcher requires flock and setsid for safe single-instance process management" >&2
  exit 1
fi

PROCESS_RECORD_DIR="$(lightld_process_record_dir "$ROOT" "$STATE_ROOT")"
mkdir -p "$PROCESS_RECORD_DIR"
exec 9> "$PROCESS_RECORD_DIR/launch.lock"
if ! flock -n 9; then
  echo "Another Lightld launcher is already starting for StateRoot '$STATE_ROOT'" >&2
  exit 1
fi

lightld_assert_state_root_mode "$ROOT" "$STATE_ROOT" live
bash "$ROOT/scripts/stop-lightld.sh" --state-root "$STATE_ROOT" all

pids=()
roles=()
cleanup() {
  if ((${#roles[@]})); then
    bash "$ROOT/scripts/stop-lightld.sh" --state-root "$STATE_ROOT" "${roles[@]}" || true
  fi
}
trap cleanup EXIT INT TERM

start_component() {
  local role="$1"
  local log_path="$2"
  local pid
  setsid bash "$ROOT/scripts/run-mainnet-live-component.sh" "$role" "$ROOT" "$STATE_ROOT" "$JOURNAL_ROOT" >> "$log_path" 2>&1 &
  pid="$!"
  sleep 0.1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Live $role component exited during startup" >&2
    return 1
  fi
  if ! lightld_write_process_record "$ROOT" "$STATE_ROOT" "$role" live "$pid"; then
    kill -9 -- "-$pid" 2>/dev/null || true
    return 1
  fi
  pids+=("$pid")
  roles+=("$role")
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local expected_dry_run="${3:-}"
  local health
  for _ in $(seq 1 120); do
    health="$(curl --noproxy '*' --silent --show-error --max-time 3 "$url" 2>/dev/null || true)"
    if [[ "$health" =~ \"status\"[[:space:]]*:[[:space:]]*\"ok\" ]]; then
      if [[ -z "$expected_dry_run" || "$health" =~ \"dryRun\"[[:space:]]*:[[:space:]]*$expected_dry_run ]]; then
        return 0
      fi
      if [[ -n "$expected_dry_run" ]]; then
        echo "$name reported the wrong execution mode" >&2
        return 1
      fi
    fi
    sleep 0.5
  done
  echo "$name health check failed: $url" >&2
  return 1
}

start_component signer "$ROOT/logs/signer.log"
start_component gmgn "$ROOT/logs/gmgn-safety.log"
start_component execution "$ROOT/logs/solana-execution.log"

wait_for_health "Signer" "http://127.0.0.1:$LIVE_LOCAL_SIGNER_PORT/health"
wait_for_health "GMGN safety" "http://127.0.0.1:$GMGN_SAFETY_PORT/health"
wait_for_health "Execution" "http://127.0.0.1:$SOLANA_EXECUTION_PORT/health" false

start_component candidate "$ROOT/logs/candidate-worker.log"
start_component daemon "$ROOT/logs/daemon.log"

flock -u 9
printf 'PIDs: signer=%s gmgn=%s execution=%s candidate=%s daemon=%s\n' "${pids[0]}" "${pids[1]}" "${pids[2]}" "${pids[3]}" "${pids[4]}"
wait
