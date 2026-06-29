$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role dashboard

Write-Host ""
Write-Host "  Starting Lightld Dashboard..."
Write-Host ""

node --experimental-strip-types src/dashboard/dashboard-server.ts
