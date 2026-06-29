$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role dashboard
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "logs") | Out-Null

Write-Host ""
Write-Host "  Starting Lightld Dashboard..."
Write-Host ""

node --experimental-strip-types src/dashboard/dashboard-server.ts 2>&1 | Tee-Object -FilePath (Join-Path $PSScriptRoot "logs/dashboard.log") -Append
