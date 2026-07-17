$ErrorActionPreference = "Stop"

if ($env:LIGHTLD_LIVE_CONFIRM -ne "I_UNDERSTAND_MAINNET") {
    throw "Set LIGHTLD_LIVE_CONFIRM=I_UNDERSTAND_MAINNET to confirm mainnet live trading"
}
. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
. (Join-Path $PSScriptRoot "scripts/lightld-process-records.ps1")
$env:LIGHTLD_RUN_MODE = "live"
$env:LIGHTLD_EXECUTION_MODE = "live"
$env:SOLANA_EXECUTION_DRY_RUN = "false"
$StateRoot = Resolve-LightldPath -Root $PSScriptRoot -Path $(if ($env:LIVE_STATE_DIR) { $env:LIVE_STATE_DIR } else { "state" })
$JournalRoot = Resolve-LightldPath -Root $PSScriptRoot -Path $(if ($env:LIVE_JOURNAL_DIR) { $env:LIVE_JOURNAL_DIR } else { "tmp/journals" })
$env:LIVE_STATE_DIR = $StateRoot
$env:LIVE_JOURNAL_DIR = $JournalRoot
$env:LIVE_CANDIDATE_POOL_DB_PATH = Join-Path $StateRoot "lightld-candidate-pool.sqlite"
$env:LIVE_DB_MIRROR_PATH = Join-Path $StateRoot "lightld-observability.sqlite"
$env:SOLANA_EXECUTION_STATE_DIR = Join-Path $StateRoot "solana-execution"
New-Item -ItemType Directory -Force -Path $StateRoot, $JournalRoot | Out-Null
Set-Location -LiteralPath $PSScriptRoot
$StartedRoles = @()
$LaunchLock = Enter-LightldLaunchLock -Root $PSScriptRoot -StateRoot $StateRoot
try {
Assert-LightldStateRootMode -Root $PSScriptRoot -StateRoot $StateRoot -Mode "live"
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -StateRoot $StateRoot -Role all

function Add-NoProxyEntry {
    param(
        [string]$Name,
        [string[]]$Entries
    )

    $Existing = [Environment]::GetEnvironmentVariable($Name, "Process")
    $Parts = @()
    if ($Existing) {
        $Parts = $Existing.Split(",", [System.StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() }
    }

    foreach ($Entry in $Entries) {
        if (-not ($Parts -contains $Entry)) {
            $Parts += $Entry
        }
    }

    [Environment]::SetEnvironmentVariable($Name, ($Parts -join ","), "Process")
}

Add-NoProxyEntry -Name "NO_PROXY" -Entries @("localhost", "127.0.0.1", "::1")
Add-NoProxyEntry -Name "no_proxy" -Entries @("localhost", "127.0.0.1", "::1")

$ProxyUrl = $env:HTTP_PROXY
if (-not $ProxyUrl) { $ProxyUrl = "<none>" }

function Quote-PSString {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Start-LightldWindow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Role,
        [string]$Title,
        [string]$Body
    )

    $RootLiteral = Quote-PSString $PSScriptRoot
    $LoaderLiteral = Quote-PSString (Join-Path $PSScriptRoot "scripts/load-env.ps1")
    $ProcessRecordHelpersLiteral = Quote-PSString (Join-Path $PSScriptRoot "scripts/lightld-process-records.ps1")
    $TitleLiteral = Quote-PSString $Title
    $StateRootLiteral = Quote-PSString $StateRoot
    $JournalRootLiteral = Quote-PSString $JournalRoot
    $RoleLiteral = Quote-PSString $Role
    $Command = @"
`$host.UI.RawUI.WindowTitle = $TitleLiteral
. $LoaderLiteral -Root $RootLiteral
. $ProcessRecordHelpersLiteral
`$env:LIGHTLD_RUN_MODE = 'live'
`$env:LIGHTLD_EXECUTION_MODE = 'live'
`$env:SOLANA_EXECUTION_DRY_RUN = 'false'
`$env:LIVE_STATE_DIR = $StateRootLiteral
`$env:LIVE_JOURNAL_DIR = $JournalRootLiteral
`$env:LIVE_CANDIDATE_POOL_DB_PATH = Join-Path $StateRootLiteral 'lightld-candidate-pool.sqlite'
`$env:LIVE_DB_MIRROR_PATH = Join-Path $StateRootLiteral 'lightld-observability.sqlite'
`$env:SOLANA_EXECUTION_STATE_DIR = Join-Path $StateRootLiteral 'solana-execution'
if (-not `$env:LIVE_LOCAL_SIGNER_PORT) { `$env:LIVE_LOCAL_SIGNER_PORT = '8787' }
if (-not `$env:SOLANA_EXECUTION_PORT) { `$env:SOLANA_EXECUTION_PORT = '8791' }
if (-not `$env:GMGN_SAFETY_PORT) { `$env:GMGN_SAFETY_PORT = '8898' }
`$env:LIVE_EXECUTION_MODE = 'http'
`$env:LIVE_SIGN_URL = "http://127.0.0.1:`$(`$env:LIVE_LOCAL_SIGNER_PORT)/sign"
`$env:LIVE_QUOTE_URL = "http://127.0.0.1:`$(`$env:SOLANA_EXECUTION_PORT)/quote"
`$env:LIVE_BROADCAST_URL = "http://127.0.0.1:`$(`$env:SOLANA_EXECUTION_PORT)/broadcast"
`$env:LIVE_CONFIRMATION_URL = "http://127.0.0.1:`$(`$env:SOLANA_EXECUTION_PORT)/confirmation"
`$env:LIVE_ACCOUNT_STATE_URL = "http://127.0.0.1:`$(`$env:SOLANA_EXECUTION_PORT)/account-state"
`$env:GMGN_SAFETY_URL = "http://127.0.0.1:`$(`$env:GMGN_SAFETY_PORT)/safety"
`$RoleLock = Enter-LightldRoleLock -Root $RootLiteral -StateRoot $StateRootLiteral -Role $RoleLiteral
Set-Location -LiteralPath $RootLiteral
New-Item -ItemType Directory -Force -Path (Join-Path (Get-Location) 'logs') | Out-Null
$Body
"@
    $Process = Start-Process powershell.exe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $Command) -WorkingDirectory $PSScriptRoot -PassThru
    Start-Sleep -Milliseconds 250
    $Process.Refresh()
    if ($Process.HasExited) {
        throw "Live $Role component exited during startup with code $($Process.ExitCode)"
    }
    try {
        [void](Write-LightldProcessRecord -Root $PSScriptRoot -StateRoot $StateRoot -Role $Role -Mode "live" -Process $Process)
    } catch {
        & taskkill.exe /PID $Process.Id /T /F | Out-Null
        throw
    }
    $script:StartedRoles += $Role
    return $Process
}

function Wait-HttpHealth {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 20
    )

    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $Deadline) {
        $OldHttpProxy = $env:HTTP_PROXY
        $OldHttpsProxy = $env:HTTPS_PROXY
        $OldAllProxy = $env:ALL_PROXY
        try {
            $env:HTTP_PROXY = ""
            $env:HTTPS_PROXY = ""
            $env:ALL_PROXY = ""
            $Response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
            if ($Response.StatusCode -ge 200 -and $Response.StatusCode -lt 300) {
                return
            }
        } catch {
            Start-Sleep -Milliseconds 500
        } finally {
            $env:HTTP_PROXY = $OldHttpProxy
            $env:HTTPS_PROXY = $OldHttpsProxy
            $env:ALL_PROXY = $OldAllProxy
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
$GmgnScriptLiteral = Quote-PSString (Join-Path $PSScriptRoot "scripts/start-gmgn-safety.ps1")
$GmgnRootLiteral = Quote-PSString $PSScriptRoot
$GmgnProcess = Start-LightldWindow -Role "gmgn" -Title "Lightld GMGN Safety" -Body @"
& $GmgnScriptLiteral -Root $GmgnRootLiteral
"@

Start-Sleep -Seconds 2
try {
    Wait-HttpHealth "http://127.0.0.1:$GmgnPort/health"
} catch {
    throw "GMGN safety sidecar health check failed; new entries must fail closed: $($_.Exception.Message)"
}

Write-Host "[2/5] Starting Signer Service (port $SignerPort)..."
[void](Start-LightldWindow -Role "signer" -Title "Lightld Signer" -Body @"
if (-not `$env:LIVE_LOCAL_SIGNER_KEYPAIR_PATH -and `$env:SOLANA_KEYPAIR_PATH) { `$env:LIVE_LOCAL_SIGNER_KEYPAIR_PATH = `$env:SOLANA_KEYPAIR_PATH }
if (-not `$env:LIVE_LOCAL_SIGNER_PORT) { `$env:LIVE_LOCAL_SIGNER_PORT = '8787' }
npm.cmd run run:signer 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/signer.log') -Append
"@)

Wait-HttpHealth "http://127.0.0.1:$SignerPort/health"

Write-Host "[3/5] Starting Solana Execution Service (port $ExecutionPort)..."
[void](Start-LightldWindow -Role "execution" -Title "Solana Mainnet Execution" -Body @"
if (-not `$env:SOLANA_EXECUTION_PORT) { `$env:SOLANA_EXECUTION_PORT = '8791' }
if (-not `$env:SOLANA_MAX_OUTPUT_SOL) { `$env:SOLANA_MAX_OUTPUT_SOL = '0.05' }
if (-not `$env:JITO_TIP_LAMPORTS) { `$env:JITO_TIP_LAMPORTS = '25000' }
if (-not `$env:SOLANA_DEFAULT_SLIPPAGE_BPS) { `$env:SOLANA_DEFAULT_SLIPPAGE_BPS = '100' }
npm.cmd run run:solana-execution 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/solana-execution.log') -Append
"@)

Wait-HttpHealth "http://127.0.0.1:$ExecutionPort/health"
$ExecutionHealth = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$ExecutionPort/health" -TimeoutSec 3
if ($ExecutionHealth.dryRun -ne $false) {
    throw "Live execution service did not report dryRun=false"
}

Write-Host "[4/5] Starting Candidate Worker (strategy new-token-v1)..."
[void](Start-LightldWindow -Role "candidate" -Title "Lightld Candidate Worker" -Body @"
npm.cmd run run:candidate-worker -- --strategy new-token-v1 --state-root-dir `$env:LIVE_STATE_DIR --db-path `$env:LIVE_CANDIDATE_POOL_DB_PATH 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/candidate-worker.log') -Append
"@)

Start-Sleep -Seconds 3

Write-Host "[5/5] Starting Daemon (strategy auto-cycle)..."
[void](Start-LightldWindow -Role "daemon" -Title "Lightld Daemon" -Body @"
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
if (-not `$env:LIVE_MAX_SINGLE_ORDER_SOL) { `$env:LIVE_MAX_SINGLE_ORDER_SOL = '0.05' }
if (-not `$env:LIVE_MAX_DAILY_SPEND_SOL) { `$env:LIVE_MAX_DAILY_SPEND_SOL = '0.2' }
while (`$true) {
    npm.cmd run run:daemon -- --strategy new-token-v1 --state-root-dir `$env:LIVE_STATE_DIR --journal-root-dir `$env:LIVE_JOURNAL_DIR 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/daemon.log') -Append
    `$ExitCode = `$LASTEXITCODE
    `$RestartAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-Warning "[Lightld Daemon] run:daemon exited code=`$ExitCode at `$RestartAt; restarting in 5 seconds"
    Start-Sleep -Seconds 5
}
"@)

Write-Host "`n========================================"
Write-Host "  All services started!"
Write-Host "  Signer:    http://127.0.0.1:$SignerPort"
Write-Host "  Execution: http://127.0.0.1:$ExecutionPort"
Write-Host "  GMGN:      http://127.0.0.1:$GmgnPort/health"
Write-Host "  Candidate: new-token-v1"
Write-Host "  Daemon:    auto strategy loop"
Write-Host "========================================"
Write-Host "  Limits default to 0.05 SOL/order, 0.2 SOL/day unless overridden by env"
} catch {
    if ($StartedRoles.Count -gt 0) {
        & (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -StateRoot $StateRoot -Role $StartedRoles
    }
    throw
} finally {
    $LaunchLock.Dispose()
}
