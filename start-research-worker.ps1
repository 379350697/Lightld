param(
    [string]$StateRoot = $(if ($env:LIVE_STATE_DIR) { $env:LIVE_STATE_DIR } else { "state-paper-realistic" })
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
$env:LIVE_STATE_DIR = $StateRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role research

$command = "Set-Location -LiteralPath '$($PSScriptRoot.Replace("'", "''"))'; while (`$true) { npm.cmd run run:research-worker -- --state-root-dir '$($StateRoot.Replace("'", "''"))'; Start-Sleep -Seconds 5 }"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command)
Write-Host "Strategy research worker started for $StateRoot"
