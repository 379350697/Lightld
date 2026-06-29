#!/usr/bin/env bash
set -euo pipefail

LIGHTLD_ROOT="${LIGHTLD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

load_dotenv() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || continue

    local key="${line%%=*}"
    local value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    export "$key=$value"
  done < "$file"
}

load_dotenv "$LIGHTLD_ROOT/.env"
load_dotenv "$LIGHTLD_ROOT/.env.local"
load_dotenv "$LIGHTLD_ROOT/.env.linux.local"

if [[ (-z "${HTTP_PROXY:-}" || "${HTTP_PROXY:-}" == "http://127.0.0.1:9") && -n "${LIGHTLD_DEFAULT_PROXY:-}" ]]; then
  export HTTP_PROXY="$LIGHTLD_DEFAULT_PROXY"
  export HTTPS_PROXY="$LIGHTLD_DEFAULT_PROXY"
fi
