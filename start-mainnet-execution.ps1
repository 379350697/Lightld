$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role execution

$ProxyUrl = $env:HTTP_PROXY
if (-not $ProxyUrl) { $ProxyUrl = "<none>" }

function Quote-PSString {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

$RootLiteral = Quote-PSString $PSScriptRoot
$LoaderLiteral = Quote-PSString (Join-Path $PSScriptRoot "scripts/load-env.ps1")

$Command = @"
`$host.UI.RawUI.WindowTitle = 'Solana Mainnet Execution'
. $LoaderLiteral -Root $RootLiteral
Set-Location -LiteralPath $RootLiteral
New-Item -ItemType Directory -Force -Path (Join-Path (Get-Location) 'logs') | Out-Null
if (-not `$env:SOLANA_EXECUTION_PORT) { `$env:SOLANA_EXECUTION_PORT = '8791' }
npm.cmd run run:solana-execution 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/solana-execution.log') -Append
"@

Write-Host "Starting Solana Mainnet Execution Service... (proxy: $ProxyUrl)"
Start-Process powershell.exe -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $Command) -WorkingDirectory $PSScriptRoot
$ExecutionPort = $env:SOLANA_EXECUTION_PORT
if (-not $ExecutionPort) { $ExecutionPort = "8791" }
Write-Host "Service started on port $ExecutionPort."
