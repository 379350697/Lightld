#!/usr/bin/env bash

lightld_resolve_path() {
  local root="$1"
  local path="$2"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$root" "$path"
  fi
}

lightld_process_record_dir() {
  local root="$1"
  local state_root="$2"
  printf '%s/.lightld-processes\n' "$(lightld_resolve_path "$root" "$state_root")"
}

lightld_assert_state_root_mode() {
  local root="$1"
  local state_root="$2"
  local mode="$3"
  local resolved_state_root marker_path existing_mode temporary_path
  resolved_state_root="$(lightld_resolve_path "$root" "$state_root")"
  mkdir -p "$resolved_state_root"
  marker_path="$resolved_state_root/.lightld-run-mode"
  if [[ -f "$marker_path" ]]; then
    existing_mode="$(tr -d '\r\n' < "$marker_path")"
    if [[ -n "$existing_mode" && "$existing_mode" != "$mode" ]]; then
      echo "StateRoot '$resolved_state_root' belongs to '$existing_mode', not '$mode'" >&2
      return 1
    fi
  fi
  temporary_path="$marker_path.$$.$RANDOM.tmp"
  printf '%s\n' "$mode" > "$temporary_path"
  mv -f "$temporary_path" "$marker_path"
}

lightld_proc_start_ticks() {
  local pid="$1"
  [[ -r "/proc/$pid/stat" ]] || return 1
  awk '{print $22}' "/proc/$pid/stat"
}

lightld_write_process_record() {
  local root="$1"
  local state_root="$2"
  local role="$3"
  local mode="$4"
  local pid="$5"
  local record_dir start_ticks pgid record_path temporary_path

  record_dir="$(lightld_process_record_dir "$root" "$state_root")"
  mkdir -p "$record_dir"
  start_ticks="$(lightld_proc_start_ticks "$pid")"
  pgid="$(ps -o pgid= -p "$pid" | tr -d '[:space:]')"
  if [[ -z "$start_ticks" || -z "$pgid" || "$pgid" != "$pid" ]]; then
    echo "Cannot verify isolated process group for Lightld $role pid=$pid" >&2
    return 1
  fi

  record_path="$record_dir/$role.record"
  temporary_path="$record_path.$$.$RANDOM.tmp"
  {
    printf 'version=1\n'
    printf 'platform=linux\n'
    printf 'root=%s\n' "$root"
    printf 'stateRoot=%s\n' "$(lightld_resolve_path "$root" "$state_root")"
    printf 'role=%s\n' "$role"
    printf 'mode=%s\n' "$mode"
    printf 'pid=%s\n' "$pid"
    printf 'processGroupId=%s\n' "$pgid"
    printf 'processStartedAtTicks=%s\n' "$start_ticks"
  } > "$temporary_path"
  mv -f "$temporary_path" "$record_path"
}

lightld_record_value() {
  local record_path="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$record_path" | head -n 1
}

lightld_remove_process_record_if_pid() {
  local root="$1"
  local state_root="$2"
  local role="$3"
  local expected_pid="$4"
  local record_path recorded_pid
  record_path="$(lightld_process_record_dir "$root" "$state_root")/$role.record"
  [[ -f "$record_path" ]] || return 0
  recorded_pid="$(lightld_record_value "$record_path" pid)"
  if [[ "$recorded_pid" == "$expected_pid" ]]; then
    rm -f "$record_path"
  fi
}
