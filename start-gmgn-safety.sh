#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
bash "$ROOT/scripts/stop-lightld.sh" gmgn

PYTHON_BIN="${GMGN_PYTHON_BIN:-python3}"
echo "Starting GMGN safety sidecar on http://127.0.0.1:${GMGN_SAFETY_PORT:-8898}"
exec "$PYTHON_BIN" scripts/gmgn-token-safety-server.py
