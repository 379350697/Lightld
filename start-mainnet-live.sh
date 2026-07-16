#!/usr/bin/env bash
set -euo pipefail

if [[ "${LIGHTLD_LIVE_CONFIRM:-}" != "I_UNDERSTAND_MAINNET" ]]; then
  echo "Set LIGHTLD_LIVE_CONFIRM=I_UNDERSTAND_MAINNET to confirm mainnet live trading" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
export LIGHTLD_RUN_MODE=live
export LIGHTLD_EXECUTION_MODE=live
export SOLANA_EXECUTION_DRY_RUN=false
bash "$ROOT/scripts/stop-lightld.sh" all
mkdir -p "$ROOT/logs"

export LIVE_EXECUTION_MODE="${LIVE_EXECUTION_MODE:-http}"
export LIVE_SIGN_URL="${LIVE_SIGN_URL:-http://127.0.0.1:8787/sign}"
export LIVE_QUOTE_URL="${LIVE_QUOTE_URL:-http://127.0.0.1:8791/quote}"
export LIVE_BROADCAST_URL="${LIVE_BROADCAST_URL:-http://127.0.0.1:8791/broadcast}"
export LIVE_CONFIRMATION_URL="${LIVE_CONFIRMATION_URL:-http://127.0.0.1:8791/confirmation}"
export LIVE_ACCOUNT_STATE_URL="${LIVE_ACCOUNT_STATE_URL:-http://127.0.0.1:8791/account-state}"

echo "Starting signer..."
npm run run:signer >> "$ROOT/logs/signer.log" 2>&1 &
SIGNER_PID=$!

echo "Starting GMGN safety sidecar..."
"${GMGN_PYTHON_BIN:-python3}" scripts/gmgn-token-safety-server.py >> "$ROOT/logs/gmgn-safety.log" 2>&1 &
GMGN_PID=$!

echo "Starting Solana execution..."
npm run run:solana-execution >> "$ROOT/logs/solana-execution.log" 2>&1 &
EXECUTION_PID=$!

echo "Starting candidate worker..."
npm run run:candidate-worker -- --strategy new-token-v1 >> "$ROOT/logs/candidate-worker.log" 2>&1 &
CANDIDATE_PID=$!

echo "Starting daemon..."
npm run run:daemon -- --strategy new-token-v1 >> "$ROOT/logs/daemon.log" 2>&1 &
DAEMON_PID=$!

echo "PIDs: signer=$SIGNER_PID gmgn=$GMGN_PID execution=$EXECUTION_PID candidate=$CANDIDATE_PID daemon=$DAEMON_PID"
wait
