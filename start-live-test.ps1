$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role signer,execution,daemon

$ProxyUrl = $env:HTTP_PROXY
if (-not $ProxyUrl) { $ProxyUrl = "<none>" }

function Quote-PSString {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Start-LightldWindow {
    param(
        [string]$Title,
        [string]$Body
    )

    $RootLiteral = Quote-PSString $PSScriptRoot
    $LoaderLiteral = Quote-PSString (Join-Path $PSScriptRoot "scripts/load-env.ps1")
    $TitleLiteral = Quote-PSString $Title
    $Command = @"
`$host.UI.RawUI.WindowTitle = $TitleLiteral
. $LoaderLiteral -Root $RootLiteral
Set-Location -LiteralPath $RootLiteral
$Body
"@
    Start-Process powershell.exe -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $Command) -WorkingDirectory $PSScriptRoot
}

Write-Host "Using proxy: $ProxyUrl"

$SignerPort = $env:LIVE_LOCAL_SIGNER_PORT
if (-not $SignerPort) { $SignerPort = "8787" }
$ExecutionPort = $env:LIVE_LOCAL_EXECUTION_PORT
if (-not $ExecutionPort) { $ExecutionPort = "8790" }

Write-Host "Starting Signer Service..."
Start-LightldWindow "Lightld Signer" @"
if (-not `$env:LIVE_LOCAL_SIGNER_KEYPAIR_PATH -and `$env:SOLANA_KEYPAIR_PATH) { `$env:LIVE_LOCAL_SIGNER_KEYPAIR_PATH = `$env:SOLANA_KEYPAIR_PATH }
if (-not `$env:LIVE_LOCAL_SIGNER_PORT) { `$env:LIVE_LOCAL_SIGNER_PORT = '8787' }
npm.cmd run run:signer
"@

Start-Sleep -Seconds 2

Write-Host "Starting Execution Service..."
Start-LightldWindow "Lightld Execution" @"
if (-not `$env:LIVE_LOCAL_EXECUTION_STATE_DIR) { `$env:LIVE_LOCAL_EXECUTION_STATE_DIR = 'state/local-execution' }
if (-not `$env:LIVE_LOCAL_EXECUTION_ACCOUNT_STATE_PATH) { `$env:LIVE_LOCAL_EXECUTION_ACCOUNT_STATE_PATH = 'state/account-state.json' }
if (-not `$env:LIVE_LOCAL_EXECUTION_PORT) { `$env:LIVE_LOCAL_EXECUTION_PORT = '8790' }
npm.cmd run run:execution
"@

Start-Sleep -Seconds 3

Write-Host "Starting Daemon Service..."
Start-LightldWindow "Lightld Daemon" @"
`$SignerPort = `$env:LIVE_LOCAL_SIGNER_PORT
if (-not `$SignerPort) { `$SignerPort = '8787' }
`$ExecutionPort = `$env:LIVE_LOCAL_EXECUTION_PORT
if (-not `$ExecutionPort) { `$ExecutionPort = '8790' }
if (-not `$env:LIVE_SIGN_URL) { `$env:LIVE_SIGN_URL = "http://127.0.0.1:`$SignerPort/sign" }
if (-not `$env:LIVE_BROADCAST_URL) { `$env:LIVE_BROADCAST_URL = "http://127.0.0.1:`$ExecutionPort/broadcast" }
if (-not `$env:LIVE_CONFIRMATION_URL) { `$env:LIVE_CONFIRMATION_URL = "http://127.0.0.1:`$ExecutionPort/confirmation" }
if (-not `$env:LIVE_ACCOUNT_STATE_URL) { `$env:LIVE_ACCOUNT_STATE_URL = "http://127.0.0.1:`$ExecutionPort/account-state" }
if (-not `$env:LIVE_REQUESTED_POSITION_SOL) { `$env:LIVE_REQUESTED_POSITION_SOL = '0.01' }
npm.cmd run run:daemon -- --strategy new-token-v1
"@

Write-Host "All services started in new windows! (proxy: $ProxyUrl)"
