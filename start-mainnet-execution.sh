#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
bash "$ROOT/scripts/stop-lightld.sh" execution
mkdir -p "$ROOT/logs"
exec > >(tee -a "$ROOT/logs/solana-execution.log") 2>&1

export SOLANA_EXECUTION_PORT="${SOLANA_EXECUTION_PORT:-8791}"
exec npm run run:solana-execution
