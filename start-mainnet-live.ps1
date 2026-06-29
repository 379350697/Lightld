$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role all

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
New-Item -ItemType Directory -Force -Path (Join-Path (Get-Location) 'logs') | Out-Null
$Body
"@
    Start-Process powershell.exe -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $Command) -WorkingDirectory $PSScriptRoot -PassThru
}

function Wait-HttpHealth {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 20
    )

    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $Deadline) {
        try {
            $Response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
            if ($Response.StatusCode -ge 200 -and $Response.StatusCode -lt 300) {
                return
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    throw "Health check failed: $Url"
}

Write-Host "========================================"
Write-Host "  Lightld Mainnet Live Trading"
Write-Host "  Proxy: $ProxyUrl"
Write-Host "========================================"
$SignerPort = $env:LIVE_LOCAL_SIGNER_PORT
if (-not $SignerPort) { $SignerPort = "8787" }
$ExecutionPort = $env:SOLANA_EXECUTION_PORT
if (-not $ExecutionPort) { $ExecutionPort = "8791" }
$GmgnPort = $env:GMGN_SAFETY_PORT
if (-not $GmgnPort) { $GmgnPort = "8898" }

Write-Host "`n[1/5] Starting GMGN safety sidecar (port $GmgnPort)..."
$GmgnProcess = Start-LightldWindow "Lightld GMGN Safety" @"
`$PythonBin = `$env:GMGN_PYTHON_BIN
if (-not `$PythonBin) { `$PythonBin = 'python' }
& `$PythonBin (Join-Path (Get-Location) 'scripts/gmgn-token-safety-server.py') 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/gmgn-safety.log') -Append
"@

Start-Sleep -Seconds 2
try {
    Wait-HttpHealth "http://127.0.0.1:$GmgnPort/health"
} catch {
    if ($GmgnProcess -and -not $GmgnProcess.HasExited) {
        Stop-Process -Id $GmgnProcess.Id -Force -ErrorAction SilentlyContinue
    }
    throw
}

Write-Host "[2/5] Starting Signer Service (port $SignerPort)..."
Start-LightldWindow "Lightld Signer" @"
if (-not `$env:LIVE_LOCAL_SIGNER_KEYPAIR_PATH -and `$env:SOLANA_KEYPAIR_PATH) { `$env:LIVE_LOCAL_SIGNER_KEYPAIR_PATH = `$env:SOLANA_KEYPAIR_PATH }
if (-not `$env:LIVE_LOCAL_SIGNER_PORT) { `$env:LIVE_LOCAL_SIGNER_PORT = '8787' }
npm.cmd run run:signer 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/signer.log') -Append
"@

Start-Sleep -Seconds 3

Write-Host "[3/5] Starting Solana Execution Service (port $ExecutionPort)..."
Start-LightldWindow "Solana Mainnet Execution" @"
if (-not `$env:SOLANA_EXECUTION_PORT) { `$env:SOLANA_EXECUTION_PORT = '8791' }
if (-not `$env:SOLANA_MAX_OUTPUT_SOL) { `$env:SOLANA_MAX_OUTPUT_SOL = '0.05' }
if (-not `$env:JITO_TIP_LAMPORTS) { `$env:JITO_TIP_LAMPORTS = '25000' }
if (-not `$env:SOLANA_DEFAULT_SLIPPAGE_BPS) { `$env:SOLANA_DEFAULT_SLIPPAGE_BPS = '100' }
npm.cmd run run:solana-execution 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/solana-execution.log') -Append
"@

Start-Sleep -Seconds 5

Write-Host "[4/5] Starting Candidate Worker (strategy new-token-v1)..."
Start-LightldWindow "Lightld Candidate Worker" @"
npm.cmd run run:candidate-worker -- --strategy new-token-v1 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/candidate-worker.log') -Append
"@

Start-Sleep -Seconds 3

Write-Host "[5/5] Starting Daemon (strategy auto-cycle)..."
Start-LightldWindow "Lightld Daemon" @"
if (-not `$env:LIVE_EXECUTION_MODE) { `$env:LIVE_EXECUTION_MODE = 'http' }
`$SignerPort = `$env:LIVE_LOCAL_SIGNER_PORT
if (-not `$SignerPort) { `$SignerPort = '8787' }
`$ExecutionPort = `$env:SOLANA_EXECUTION_PORT
if (-not `$ExecutionPort) { `$ExecutionPort = '8791' }
if (-not `$env:LIVE_SIGN_URL) { `$env:LIVE_SIGN_URL = "http://127.0.0.1:`$SignerPort/sign" }
if (-not `$env:LIVE_QUOTE_URL) { `$env:LIVE_QUOTE_URL = "http://127.0.0.1:`$ExecutionPort/quote" }
if (-not `$env:LIVE_BROADCAST_URL) { `$env:LIVE_BROADCAST_URL = "http://127.0.0.1:`$ExecutionPort/broadcast" }
if (-not `$env:LIVE_CONFIRMATION_URL) { `$env:LIVE_CONFIRMATION_URL = "http://127.0.0.1:`$ExecutionPort/confirmation" }
if (-not `$env:LIVE_ACCOUNT_STATE_URL) { `$env:LIVE_ACCOUNT_STATE_URL = "http://127.0.0.1:`$ExecutionPort/account-state" }
if (-not `$env:LIVE_REQUESTED_POSITION_SOL) { `$env:LIVE_REQUESTED_POSITION_SOL = '0.01' }
if (-not `$env:LIVE_MAX_SINGLE_ORDER_SOL) { `$env:LIVE_MAX_SINGLE_ORDER_SOL = '0.05' }
if (-not `$env:LIVE_MAX_DAILY_SPEND_SOL) { `$env:LIVE_MAX_DAILY_SPEND_SOL = '0.2' }
if (-not `$env:LIVE_METEORA_SORT_BY) { `$env:LIVE_METEORA_SORT_BY = 'fee_tvl_ratio_24h:desc' }
if (-not `$env:LIVE_METEORA_FILTER_BY) { `$env:LIVE_METEORA_FILTER_BY = 'tvl>=10000 && is_blacklisted=false' }
if (-not `$env:LIVE_METEORA_PAGE_SIZE) { `$env:LIVE_METEORA_PAGE_SIZE = '50' }
npm.cmd run run:daemon -- --strategy new-token-v1 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/daemon.log') -Append
"@

Write-Host "`n========================================"
Write-Host "  All services started!"
Write-Host "  Signer:    http://127.0.0.1:$SignerPort"
Write-Host "  Execution: http://127.0.0.1:$ExecutionPort"
Write-Host "  GMGN:      http://127.0.0.1:$GmgnPort/health"
Write-Host "  Candidate: new-token-v1"
Write-Host "  Daemon:    auto strategy loop"
Write-Host "========================================"
Write-Host "  Limits default to 0.05 SOL/order, 0.2 SOL/day unless overridden by env"
