#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/load-env.sh"
bash "$ROOT/scripts/stop-lightld.sh" dashboard
mkdir -p "$ROOT/logs"
exec > >(tee -a "$ROOT/logs/dashboard.log") 2>&1

exec npm run run:dashboard
