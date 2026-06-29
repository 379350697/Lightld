$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role gmgn

$PythonBin = $env:GMGN_PYTHON_BIN
if (-not $PythonBin) { $PythonBin = "python" }

Write-Host "Starting GMGN safety sidecar on http://127.0.0.1:8898"
& $PythonBin (Join-Path $PSScriptRoot "scripts/gmgn-token-safety-server.py")
