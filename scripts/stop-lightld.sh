#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIGHTLD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ROLES=("$@")
if [[ ${#ROLES[@]} -eq 0 || " ${ROLES[*]} " == *" all "* ]]; then
  ROLES=(signer execution gmgn candidate research daemon dashboard)
fi

patterns_for_role() {
  case "$1" in
    signer) echo "run:signer|local-live-signer" ;;
    execution) echo "run:execution|run:solana-execution|local-live-execution|solana-execution" ;;
    gmgn) echo "gmgn-token-safety-server.py" ;;
    candidate) echo "run:candidate-worker|candidate-worker" ;;
    research) echo "run:research-worker|run-research-worker-main" ;;
    daemon) echo "run:daemon|live-daemon" ;;
    dashboard) echo "run:dashboard|dashboard-server" ;;
    *) echo "" ;;
  esac
}

ports_for_role() {
  case "$1" in
    signer) echo "8787 8788 ${LIVE_LOCAL_SIGNER_PORT:-}" ;;
    execution) echo "8790 8791 ${SOLANA_EXECUTION_PORT:-}" ;;
    gmgn) echo "8898 ${GMGN_SAFETY_PORT:-}" ;;
    dashboard) echo "8899 ${DASHBOARD_PORT:-}" ;;
    *) echo "" ;;
  esac
}

collect_port_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' || true
  fi
}

TARGET_PIDS=()

for role in "${ROLES[@]}"; do
  pattern="$(patterns_for_role "$role")"
  if [[ -z "$pattern" ]]; then
    echo "Unknown Lightld role '$role', skipping"
    continue
  fi

  while IFS= read -r pid; do
    [[ -n "$pid" && "$pid" != "$$" ]] && TARGET_PIDS+=("$pid")
  done < <(pgrep -f "$ROOT.*($pattern)|($pattern).*$ROOT|lightld.*($pattern)|($pattern).*lightld" 2>/dev/null || true)

  for port in $(ports_for_role "$role"); do
    while IFS= read -r pid; do
      [[ -n "$pid" && "$pid" != "$$" ]] && TARGET_PIDS+=("$pid")
    done < <(collect_port_pids "$port")
  done
done

if [[ ${#TARGET_PIDS[@]} -eq 0 ]]; then
  echo "No old Lightld instances found for role(s): ${ROLES[*]}"
  exit 0
fi

mapfile -t UNIQUE_PIDS < <(printf '%s\n' "${TARGET_PIDS[@]}" | sort -n | uniq)
for pid in "${UNIQUE_PIDS[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping old Lightld process: pid=$pid"
    kill "$pid" 2>/dev/null || true
  fi
done

sleep 1

for pid in "${UNIQUE_PIDS[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "Force stopping old Lightld process: pid=$pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
done
