#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
STATE_ROOT="${1:-${LIVE_STATE_DIR:-state-paper-realistic}}"
bash "$ROOT/scripts/stop-lightld.sh" research
mkdir -p "$ROOT/logs"

while true; do
  npm run run:research-worker -- --state-root-dir "$STATE_ROOT" >> "$ROOT/logs/research-worker.log" 2>&1 || true
  sleep 5
done
