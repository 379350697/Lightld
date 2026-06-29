#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
bash "$ROOT/scripts/stop-lightld.sh" signer
mkdir -p "$ROOT/logs"
exec > >(tee -a "$ROOT/logs/signer.log") 2>&1

export LIVE_LOCAL_SIGNER_KEYPAIR_PATH="${LIVE_LOCAL_SIGNER_KEYPAIR_PATH:-${SOLANA_KEYPAIR_PATH:-secrets/burner-live.json}}"
export LIVE_LOCAL_SIGNER_PORT="${LIVE_LOCAL_SIGNER_PORT:-8788}"
exec npm run run:signer
