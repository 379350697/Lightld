#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIGHTLD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_ROOT=""
ROLES=()
while (($#)); do
  case "$1" in
    --state-root)
      [[ $# -ge 2 ]] || { echo "--state-root requires a value" >&2; exit 1; }
      STATE_ROOT="$2"
      shift 2
      ;;
    *)
      ROLES+=("$1")
      shift
      ;;
  esac
done
if [[ ${#ROLES[@]} -eq 0 || " ${ROLES[*]} " == *" all "* ]]; then
  ROLES=(signer execution gmgn candidate research daemon dashboard)
fi

source "$ROOT/scripts/lightld-process-records.sh"

is_selected_role() {
  local candidate="$1"
  local role
  for role in "${ROLES[@]}"; do
    [[ "$role" == "$candidate" ]] && return 0
  done
  return 1
}

patterns_for_role() {
  case "$1" in
    signer) echo "run:signer|local-live-signer" ;;
    execution) echo "run:execution|run:solana-execution|local-live-execution|solana-execution" ;;
    gmgn) echo "gmgn-token-safety-server.py|start-gmgn-safety" ;;
    candidate) echo "run:candidate-worker|candidate-worker" ;;
    research) echo "run:research-worker|run-research-worker-main" ;;
    daemon) echo "run:daemon|live-daemon|run-live-daemon-main" ;;
    dashboard) echo "run:dashboard|dashboard-server" ;;
    *) echo "" ;;
  esac
}

record_dirs=()
if [[ -n "$STATE_ROOT" ]]; then
  STATE_ROOT="$(lightld_resolve_path "$ROOT" "$STATE_ROOT")"
  record_dirs+=("$(lightld_process_record_dir "$ROOT" "$STATE_ROOT")")
else
  record_dirs+=("$(lightld_process_record_dir "$ROOT" "${LIVE_STATE_DIR:-state}")")
  record_dirs+=("$(lightld_process_record_dir "$ROOT" state-paper-realistic)")
  shopt -s nullglob
  for candidate_dir in "$ROOT"/*/.lightld-processes; do
    record_dirs+=("$candidate_dir")
  done
  shopt -u nullglob
fi

managed_found=false
managed_pids=()
managed_records=()
current_pgid="$(ps -o pgid= -p $$ | tr -d '[:space:]')"
shopt -s nullglob
for record_dir in "${record_dirs[@]}"; do
  [[ -d "$record_dir" ]] || continue
  for record_path in "$record_dir"/*.record; do
    platform="$(lightld_record_value "$record_path" platform)"
    record_root="$(lightld_record_value "$record_path" root)"
    role="$(lightld_record_value "$record_path" role)"
    pid="$(lightld_record_value "$record_path" pid)"
    expected_pgid="$(lightld_record_value "$record_path" processGroupId)"
    expected_ticks="$(lightld_record_value "$record_path" processStartedAtTicks)"

    [[ "$platform" == linux && "$record_root" == "$ROOT" ]] || continue
    is_selected_role "$role" || continue
    managed_found=true

    if [[ ! "$pid" =~ ^[0-9]+$ || "$pid" == "$$" || "$pid" == "$current_pgid" ]]; then
      echo "Refusing invalid or protected Lightld process record: $record_path" >&2
      continue
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Recorded Lightld process is already stopped: $role pid=$pid"
      rm -f "$record_path"
      continue
    fi

    actual_ticks="$(lightld_proc_start_ticks "$pid" 2>/dev/null || true)"
    actual_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -z "$actual_ticks" || "$actual_ticks" != "$expected_ticks" || "$actual_pgid" != "$expected_pgid" || "$actual_pgid" != "$pid" ]]; then
      echo "PID identity changed; refusing to stop managed $role pid=$pid" >&2
      continue
    fi

    echo "Stopping Lightld process group: $role pid=$pid"
    kill -- "-$pid" 2>/dev/null || true
    managed_pids+=("$pid")
    managed_records+=("$record_path")
  done
done
shopt -u nullglob

if ((${#managed_pids[@]})); then
  sleep 1
  for index in "${!managed_pids[@]}"; do
    pid="${managed_pids[$index]}"
    record_path="${managed_records[$index]}"
    if kill -0 "$pid" 2>/dev/null; then
      actual_ticks="$(lightld_proc_start_ticks "$pid" 2>/dev/null || true)"
      expected_ticks="$(lightld_record_value "$record_path" processStartedAtTicks)"
      if [[ -n "$actual_ticks" && "$actual_ticks" == "$expected_ticks" ]]; then
        echo "Force stopping Lightld process group: pid=$pid"
        kill -9 -- "-$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$record_path"
  done
fi

# Compatibility cleanup for pre-manifest launchers. A legacy process must expose
# both this exact repository root and a role-specific command. No port-only kill is
# allowed, so an unrelated listener can never be terminated by this script.
legacy_pids=()
while read -r pid command; do
  [[ "$pid" =~ ^[0-9]+$ && "$pid" != "$$" ]] || continue
  [[ "$command" == *"$ROOT"* ]] || continue
  for role in "${ROLES[@]}"; do
    pattern="$(patterns_for_role "$role")"
    [[ -n "$pattern" ]] || continue
    if [[ "$command" =~ $pattern ]]; then
      legacy_pids+=("$pid")
      break
    fi
  done
done < <(ps -eo pid=,args= 2>/dev/null || true)

collect_descendants() {
  local parent="$1"
  local child
  while read -r child; do
    [[ "$child" =~ ^[0-9]+$ ]] || continue
    collect_descendants "$child"
    legacy_descendants+=("$child")
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

if ((${#legacy_pids[@]})); then
  mapfile -t unique_legacy_pids < <(printf '%s\n' "${legacy_pids[@]}" | sort -n -u)
  for pid in "${unique_legacy_pids[@]}"; do
    legacy_descendants=()
    collect_descendants "$pid"
    echo "Stopping verified legacy Lightld process tree: pid=$pid"
    if ((${#legacy_descendants[@]})); then
      kill "${legacy_descendants[@]}" 2>/dev/null || true
    fi
    kill "$pid" 2>/dev/null || true
  done
fi

if [[ "$managed_found" == false && ${#legacy_pids[@]} -eq 0 ]]; then
  echo "No verified Lightld instances found for role(s): ${ROLES[*]}"
fi
