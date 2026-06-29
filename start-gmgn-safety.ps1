$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role gmgn
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "logs") | Out-Null

$PythonBin = $env:GMGN_PYTHON_BIN
if (-not $PythonBin) { $PythonBin = "python" }

Write-Host "Starting GMGN safety sidecar on http://127.0.0.1:8898"
& $PythonBin (Join-Path $PSScriptRoot "scripts/gmgn-token-safety-server.py") 2>&1 | Tee-Object -FilePath (Join-Path $PSScriptRoot "logs/gmgn-safety.log") -Append
