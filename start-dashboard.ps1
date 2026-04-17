$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Starting Lightld Dashboard..."
Write-Host ""

node --experimental-strip-types src/dashboard/dashboard-server.ts
