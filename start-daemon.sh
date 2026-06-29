#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
bash "$ROOT/scripts/stop-lightld.sh" daemon
mkdir -p "$ROOT/logs"
exec > >(tee -a "$ROOT/logs/daemon.log") 2>&1

SIGNER_PORT="${LIVE_LOCAL_SIGNER_PORT:-8788}"
EXECUTION_PORT="${SOLANA_EXECUTION_PORT:-8791}"

export LIVE_EXECUTION_MODE="${LIVE_EXECUTION_MODE:-http}"
export LIVE_SIGN_URL="${LIVE_SIGN_URL:-http://127.0.0.1:${SIGNER_PORT}/sign}"
export LIVE_QUOTE_URL="${LIVE_QUOTE_URL:-http://127.0.0.1:${EXECUTION_PORT}/quote}"
export LIVE_BROADCAST_URL="${LIVE_BROADCAST_URL:-http://127.0.0.1:${EXECUTION_PORT}/broadcast}"
export LIVE_CONFIRMATION_URL="${LIVE_CONFIRMATION_URL:-http://127.0.0.1:${EXECUTION_PORT}/confirmation}"
export LIVE_ACCOUNT_STATE_URL="${LIVE_ACCOUNT_STATE_URL:-http://127.0.0.1:${EXECUTION_PORT}/account-state}"

exec npm run run:daemon -- --strategy "${LIGHTLD_STRATEGY_ID:-new-token-v1}"
