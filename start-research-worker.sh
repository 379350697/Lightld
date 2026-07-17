#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
source "$ROOT/scripts/lightld-process-records.sh"

STATE_ROOT="$(lightld_resolve_path "$ROOT" "${1:-${LIVE_STATE_DIR:-state-paper-realistic}}")"
JOURNAL_ROOT="$(lightld_resolve_path "$ROOT" "${LIVE_JOURNAL_DIR:-tmp/paper-realistic-journals}")"
mkdir -p "$STATE_ROOT" "$JOURNAL_ROOT" "$ROOT/logs"
STATE_ROOT="$(cd "$STATE_ROOT" && pwd -P)"
JOURNAL_ROOT="$(cd "$JOURNAL_ROOT" && pwd -P)"

export LIGHTLD_RUN_MODE=mechanical-soak
export LIGHTLD_EXECUTION_MODE=mechanical-soak
export LIVE_STATE_DIR="$STATE_ROOT"

if ! command -v flock >/dev/null 2>&1 || ! command -v setsid >/dev/null 2>&1; then
  echo "Research worker launcher requires flock and setsid" >&2
  exit 1
fi

PROCESS_RECORD_DIR="$(lightld_process_record_dir "$ROOT" "$STATE_ROOT")"
mkdir -p "$PROCESS_RECORD_DIR"
exec 9> "$PROCESS_RECORD_DIR/launch.lock"
if ! flock -n 9; then
  echo "Another Lightld launcher is already starting for StateRoot '$STATE_ROOT'" >&2
  exit 1
fi
lightld_assert_state_root_mode "$ROOT" "$STATE_ROOT" mechanical-soak
bash "$ROOT/scripts/stop-lightld.sh" --state-root "$STATE_ROOT" research
setsid bash "$ROOT/scripts/run-paper-realistic-component.sh" \
  research "$ROOT" "$STATE_ROOT" "$JOURNAL_ROOT" new-token-v1 5 10000 2000 \
  >> "$ROOT/logs/research-worker.log" 2>&1 &
pid="$!"
sleep 0.1
if ! kill -0 "$pid" 2>/dev/null; then
  echo "Strategy research worker exited during startup" >&2
  exit 1
fi
if ! lightld_write_process_record "$ROOT" "$STATE_ROOT" research mechanical-soak "$pid"; then
  kill -9 -- "-$pid" 2>/dev/null || true
  exit 1
fi
flock -u 9
echo "Strategy research worker started for $STATE_ROOT (pid=$pid)"
