#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIGHTLD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_ROOT="${LIVE_STATE_DIR:-$ROOT/state-paper-realistic}"
JOURNAL_ROOT="${LIVE_JOURNAL_DIR:-$ROOT/tmp/paper-realistic-journals}"
MAX_ACTIVE_POSITIONS="${LIVE_MAX_ACTIVE_POSITIONS:-5}"
TICK_INTERVAL_MS="${LIVE_DAEMON_TICK_INTERVAL_MS:-10000}"
HOT_TICK_INTERVAL_MS="${LIVE_DAEMON_HOT_TICK_INTERVAL_MS:-2000}"
STRATEGY="${LIGHTLD_PAPER_STRATEGY:-new-token-v1}"

case "$STRATEGY" in
  new-token-v1|large-pool-v1) ;;
  *)
    echo "LIGHTLD_PAPER_STRATEGY must be new-token-v1 or large-pool-v1" >&2
    exit 1
    ;;
esac

cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
source "$ROOT/scripts/lightld-process-records.sh"

STATE_ROOT="$(lightld_resolve_path "$ROOT" "$STATE_ROOT")"
JOURNAL_ROOT="$(lightld_resolve_path "$ROOT" "$JOURNAL_ROOT")"
mkdir -p "$STATE_ROOT" "$JOURNAL_ROOT" "$ROOT/logs"
STATE_ROOT="$(cd "$STATE_ROOT" && pwd -P)"
JOURNAL_ROOT="$(cd "$JOURNAL_ROOT" && pwd -P)"

if ! command -v flock >/dev/null 2>&1 || ! command -v setsid >/dev/null 2>&1; then
  echo "Paper launcher requires flock and setsid for safe single-instance process management" >&2
  exit 1
fi

# Reassert paper isolation after dotenv loading so local files cannot turn this launcher live.
export LIGHTLD_RUN_MODE=mechanical-soak
export LIGHTLD_EXECUTION_MODE=mechanical-soak
export SOLANA_EXECUTION_DRY_RUN=true
export LIVE_LOCAL_SIGNER_PORT="${LIVE_LOCAL_SIGNER_PORT:-8787}"
export SOLANA_EXECUTION_PORT="${SOLANA_EXECUTION_PORT:-8791}"
export GMGN_SAFETY_PORT="${GMGN_SAFETY_PORT:-8898}"
export GMGN_SAFETY_URL="${GMGN_SAFETY_URL:-http://127.0.0.1:$GMGN_SAFETY_PORT/safety}"
export SOLANA_MAX_OUTPUT_SOL="${SOLANA_MAX_OUTPUT_SOL:-0.05}"
export LIVE_MAX_SINGLE_ORDER_SOL="${LIVE_MAX_SINGLE_ORDER_SOL:-0.05}"
export LIVE_MAX_DAILY_SPEND_SOL="${LIVE_MAX_DAILY_SPEND_SOL:-0.2}"
export LIVE_EXECUTION_MODE=http
export LIVE_STATE_DIR="$STATE_ROOT"
export LIVE_JOURNAL_DIR="$JOURNAL_ROOT"
export SOLANA_EXECUTION_STATE_DIR="$STATE_ROOT/solana-execution"
export LIVE_CANDIDATE_POOL_DB_PATH="$STATE_ROOT/lightld-candidate-pool.sqlite"
export LIVE_DB_MIRROR_PATH="$STATE_ROOT/lightld-observability.sqlite"
export LIVE_QUOTE_URL="${LIVE_QUOTE_URL:-http://127.0.0.1:$SOLANA_EXECUTION_PORT/quote}"
export LIVE_SIGN_URL="${LIVE_SIGN_URL:-http://127.0.0.1:$LIVE_LOCAL_SIGNER_PORT/sign}"
export LIVE_BROADCAST_URL="${LIVE_BROADCAST_URL:-http://127.0.0.1:$SOLANA_EXECUTION_PORT/broadcast}"
export LIVE_CONFIRMATION_URL="${LIVE_CONFIRMATION_URL:-http://127.0.0.1:$SOLANA_EXECUTION_PORT/confirmation}"
export LIVE_ACCOUNT_STATE_URL="${LIVE_ACCOUNT_STATE_URL:-http://127.0.0.1:$SOLANA_EXECUTION_PORT/account-state}"
export LIVE_MAX_ACTIVE_POSITIONS="$MAX_ACTIVE_POSITIONS"
export LIVE_DAEMON_TICK_INTERVAL_MS="$TICK_INTERVAL_MS"
export LIVE_DAEMON_HOT_TICK_INTERVAL_MS="$HOT_TICK_INTERVAL_MS"

PROCESS_RECORD_DIR="$(lightld_process_record_dir "$ROOT" "$STATE_ROOT")"
mkdir -p "$PROCESS_RECORD_DIR"
exec 9> "$PROCESS_RECORD_DIR/launch.lock"
if ! flock -n 9; then
  echo "Another Lightld launcher is already starting for StateRoot '$STATE_ROOT'" >&2
  exit 1
fi

lightld_assert_state_root_mode "$ROOT" "$STATE_ROOT" mechanical-soak
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
  setsid bash "$ROOT/scripts/run-paper-realistic-component.sh" \
    "$role" "$ROOT" "$STATE_ROOT" "$JOURNAL_ROOT" "$STRATEGY" \
    "$MAX_ACTIVE_POSITIONS" "$TICK_INTERVAL_MS" "$HOT_TICK_INTERVAL_MS" \
    >> "$log_path" 2>&1 &
  pid="$!"
  sleep 0.1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Paper $role component exited during startup" >&2
    return 1
  fi
  if ! lightld_write_process_record "$ROOT" "$STATE_ROOT" "$role" mechanical-soak "$pid"; then
    kill -9 -- "-$pid" 2>/dev/null || true
    return 1
  fi
  pids+=("$pid")
  roles+=("$role")
}

start_component signer "$ROOT/logs/paper-signer.log"
start_component gmgn "$ROOT/logs/paper-gmgn-safety.log"
start_component execution "$ROOT/logs/paper-execution.log"

signer_ready=false
for _ in $(seq 1 120); do
  health="$(curl --noproxy '*' --silent --show-error --max-time 3 "http://127.0.0.1:$LIVE_LOCAL_SIGNER_PORT/health" 2>/dev/null || true)"
  if [[ "$health" =~ \"status\"[[:space:]]*:[[:space:]]*\"ok\" ]]; then
    signer_ready=true
    break
  fi
  sleep 0.5
done
if [[ "$signer_ready" != true ]]; then
  echo "Paper signer health check failed" >&2
  exit 1
fi

gmgn_ready=false
for _ in $(seq 1 120); do
  health="$(curl --noproxy '*' --silent --show-error --max-time 3 "http://127.0.0.1:$GMGN_SAFETY_PORT/health" 2>/dev/null || true)"
  if [[ "$health" =~ \"status\"[[:space:]]*:[[:space:]]*\"ok\" ]]; then
    gmgn_ready=true
    break
  fi
  sleep 0.5
done
if [[ "$gmgn_ready" != true ]]; then
  echo "Paper GMGN safety health check failed" >&2
  exit 1
fi

execution_ready=false
for _ in $(seq 1 120); do
  health="$(curl --noproxy '*' --silent --show-error --max-time 3 "http://127.0.0.1:$SOLANA_EXECUTION_PORT/health" 2>/dev/null || true)"
  if [[ "$health" =~ \"dryRun\"[[:space:]]*:[[:space:]]*true ]]; then
    execution_ready=true
    break
  fi
  if [[ "$health" =~ \"dryRun\"[[:space:]]*:[[:space:]]*false ]]; then
    echo "Refusing to start paper daemon against a live execution service" >&2
    exit 1
  fi
  sleep 0.5
done
if [[ "$execution_ready" != true ]]; then
  echo "Paper execution health check failed or dryRun was not true" >&2
  exit 1
fi

start_component candidate "$ROOT/logs/paper-candidate.log"
start_component research "$ROOT/logs/paper-research.log"
start_component daemon "$ROOT/logs/paper-daemon.log"

flock -u 9

printf '{"mode":"mechanical-soak","stateRoot":"%s","pids":[%s]}\n' "$STATE_ROOT" "$(IFS=,; echo "${pids[*]}")"
wait
