$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role daemon

$RootLiteral = "'" + $PSScriptRoot.Replace("'", "''") + "'"
$LoaderLiteral = "'" + (Join-Path $PSScriptRoot "scripts/load-env.ps1").Replace("'", "''") + "'"
$Command = @"
`$host.UI.RawUI.WindowTitle = 'Lightld Daemon'
. $LoaderLiteral -Root $RootLiteral
Set-Location -LiteralPath $RootLiteral
New-Item -ItemType Directory -Force -Path (Join-Path (Get-Location) 'logs') | Out-Null
if (-not `$env:LIVE_EXECUTION_MODE) { `$env:LIVE_EXECUTION_MODE = 'http' }
`$SignerPort = `$env:LIVE_LOCAL_SIGNER_PORT
if (-not `$SignerPort) { `$SignerPort = '8788' }
`$ExecutionPort = `$env:SOLANA_EXECUTION_PORT
if (-not `$ExecutionPort) { `$ExecutionPort = '8791' }
if (-not `$env:LIVE_SIGN_URL) { `$env:LIVE_SIGN_URL = "http://127.0.0.1:`$SignerPort/sign" }
if (-not `$env:LIVE_QUOTE_URL) { `$env:LIVE_QUOTE_URL = "http://127.0.0.1:`$ExecutionPort/quote" }
if (-not `$env:LIVE_BROADCAST_URL) { `$env:LIVE_BROADCAST_URL = "http://127.0.0.1:`$ExecutionPort/broadcast" }
if (-not `$env:LIVE_CONFIRMATION_URL) { `$env:LIVE_CONFIRMATION_URL = "http://127.0.0.1:`$ExecutionPort/confirmation" }
if (-not `$env:LIVE_ACCOUNT_STATE_URL) { `$env:LIVE_ACCOUNT_STATE_URL = "http://127.0.0.1:`$ExecutionPort/account-state" }
npm.cmd run run:daemon -- --strategy new-token-v1 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/daemon.log') -Append
"@

Start-Process powershell.exe -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $Command) -WorkingDirectory $PSScriptRoot
Write-Host "Daemon started."
