param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("signer", "gmgn", "execution", "candidate", "research", "daemon", "dashboard")]
    [string]$Role,
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$StateRoot = "state-paper-realistic",
    [string]$JournalRoot = "tmp/paper-realistic-journals",
    [ValidateSet("new-token-v1", "large-pool-v1")]
    [string]$Strategy = "new-token-v1",
    [int]$MaxActivePositions = 5,
    [int]$TickIntervalMs = 10000,
    [int]$HotTickIntervalMs = 2000
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path -LiteralPath $Root).Path
$StateRoot = if ([System.IO.Path]::IsPathRooted($StateRoot)) { [System.IO.Path]::GetFullPath($StateRoot) } else { [System.IO.Path]::GetFullPath((Join-Path $Root $StateRoot)) }
$JournalRoot = if ([System.IO.Path]::IsPathRooted($JournalRoot)) { [System.IO.Path]::GetFullPath($JournalRoot) } else { [System.IO.Path]::GetFullPath((Join-Path $Root $JournalRoot)) }
Set-Location $Root
& (Join-Path $PSScriptRoot "load-env.ps1") -Root $Root -OverlayFiles @(".env.paper.local")
$paperMaxActivePositions = 0
$rawPaperMaxActivePositions = [Environment]::GetEnvironmentVariable("LIVE_PAPER_MAX_ACTIVE_POSITIONS")
if (-not [string]::IsNullOrWhiteSpace($rawPaperMaxActivePositions)) {
    if (-not [int]::TryParse($rawPaperMaxActivePositions, [ref]$paperMaxActivePositions) -or $paperMaxActivePositions -lt 1 -or $paperMaxActivePositions -gt 100) {
        throw "LIVE_PAPER_MAX_ACTIVE_POSITIONS must be an integer from 1 to 100."
    }
    $MaxActivePositions = $paperMaxActivePositions
}
. (Join-Path $PSScriptRoot "lightld-process-records.ps1")
$RoleLock = Enter-LightldRoleLock -Root $Root -StateRoot $StateRoot -Role $Role
$env:LIGHTLD_RUN_MODE = "mechanical-soak"
$env:LIGHTLD_EXECUTION_MODE = "mechanical-soak"
$env:SOLANA_EXECUTION_DRY_RUN = "true"
if (-not $env:LIVE_LOCAL_SIGNER_PORT) { $env:LIVE_LOCAL_SIGNER_PORT = "8787" }
if (-not $env:SOLANA_EXECUTION_PORT) { $env:SOLANA_EXECUTION_PORT = "8791" }
if (-not $env:GMGN_SAFETY_PORT) { $env:GMGN_SAFETY_PORT = "8898" }
if (-not $env:GMGN_SAFETY_URL) { $env:GMGN_SAFETY_URL = "http://127.0.0.1:$($env:GMGN_SAFETY_PORT)/safety" }
if (-not $env:SOLANA_MAX_OUTPUT_SOL) { $env:SOLANA_MAX_OUTPUT_SOL = "0.05" }
if (-not $env:JITO_TIP_LAMPORTS) { $env:JITO_TIP_LAMPORTS = "25000" }
if (-not $env:SOLANA_DEFAULT_SLIPPAGE_BPS) { $env:SOLANA_DEFAULT_SLIPPAGE_BPS = "100" }
if (-not $env:LIVE_MAX_SINGLE_ORDER_SOL) { $env:LIVE_MAX_SINGLE_ORDER_SOL = "0.05" }
if (-not $env:LIVE_MAX_DAILY_SPEND_SOL) { $env:LIVE_MAX_DAILY_SPEND_SOL = "0.2" }

try {
    $Host.UI.RawUI.WindowTitle = "Lightld Paper Realistic $Role"
} catch {
    # Scheduled Task runs without an interactive console.
}

function Invoke-PaperComponentForever {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Component,
        [Parameter(Mandatory = $true)]
        [scriptblock]$StartComponent,
        [int]$RestartDelayMs = 5000
    )

    while ($true) {
        $startedAt = (Get-Date).ToUniversalTime().ToString("o")
        Write-Host "[PaperRealistic] $Component starting at $startedAt"
        $exitCode = "unknown"
        try {
            & $StartComponent
            if ($null -ne $LASTEXITCODE) {
                $exitCode = [string]$LASTEXITCODE
            }
        } catch {
            $exitCode = "exception: $($_.Exception.Message)"
        }
        $stoppedAt = (Get-Date).ToUniversalTime().ToString("o")
        Write-Warning "[PaperRealistic] $Component exited with code $exitCode at $stoppedAt; restarting in ${RestartDelayMs}ms"
        Start-Sleep -Milliseconds $RestartDelayMs
    }
}

if ($Role -eq "signer") {
    Invoke-PaperComponentForever -Component "signer" -StartComponent { npm.cmd run run:signer }
    exit
}

if ($Role -eq "gmgn") {
    Invoke-PaperComponentForever -Component "gmgn" -StartComponent { & (Join-Path $PSScriptRoot "start-gmgn-safety.ps1") -Root $Root }
    exit
}

if ($Role -eq "execution") {
    $env:SOLANA_EXECUTION_STATE_DIR = (Join-Path $StateRoot "solana-execution")
    Invoke-PaperComponentForever -Component "execution" -StartComponent { npm.cmd run run:solana-execution }
    exit
}

if ($Role -eq "candidate") {
    $env:LIVE_STATE_DIR = $StateRoot
    $env:LIVE_CANDIDATE_POOL_DB_PATH = (Join-Path $StateRoot "lightld-candidate-pool.sqlite")
    $gmgnHealthUrl = "http://127.0.0.1:$($env:GMGN_SAFETY_PORT)/health"
    $deadline = (Get-Date).AddSeconds(60)
    $gmgnReady = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -UseBasicParsing -Uri $gmgnHealthUrl -TimeoutSec 3
            if ($health.status -eq "ok") {
                $gmgnReady = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $gmgnReady) {
        throw "Paper GMGN safety health check failed: $gmgnHealthUrl"
    }
    $restartDelayMs = 5000
    $parsedRestartDelayMs = 0
    if ([int]::TryParse($env:LIVE_CANDIDATE_WORKER_RESTART_DELAY_MS, [ref]$parsedRestartDelayMs) -and $parsedRestartDelayMs -gt 0) {
        $restartDelayMs = $parsedRestartDelayMs
    }

    while ($true) {
        $startedAt = (Get-Date).ToUniversalTime().ToString("o")
        Write-Host "[PaperRealistic] candidate worker starting at $startedAt"
        npm.cmd run run:candidate-worker -- --strategy $Strategy --state-root-dir $StateRoot --db-path $env:LIVE_CANDIDATE_POOL_DB_PATH
        $exitCode = $LASTEXITCODE
        $stoppedAt = (Get-Date).ToUniversalTime().ToString("o")
        Write-Warning "[PaperRealistic] candidate worker exited with code $exitCode at $stoppedAt; restarting in ${restartDelayMs}ms"
        Start-Sleep -Milliseconds $restartDelayMs
    }
}

if ($Role -eq "research") {
    $env:LIVE_STATE_DIR = $StateRoot
    while ($true) {
        npm.cmd run run:research-worker -- --state-root-dir $StateRoot
        Write-Warning "[PaperRealistic] research worker exited with code $LASTEXITCODE; restarting in 5 seconds"
        Start-Sleep -Seconds 5
    }
}

if ($Role -eq "dashboard") {
    $env:LIVE_STATE_DIR = $StateRoot
    $env:LIVE_JOURNAL_DIR = $JournalRoot
    $env:LIVE_DB_MIRROR_PATH = (Join-Path $StateRoot "lightld-observability.sqlite")
    if (-not $env:DASHBOARD_PORT) { $env:DASHBOARD_PORT = "8899" }
    Invoke-PaperComponentForever -Component "dashboard" -StartComponent { npm.cmd run run:dashboard }
    exit
}

$env:LIVE_EXECUTION_MODE = "http"
$env:LIVE_STATE_DIR = $StateRoot
$env:LIVE_JOURNAL_DIR = $JournalRoot
$env:LIVE_DB_MIRROR_PATH = (Join-Path $StateRoot "lightld-observability.sqlite")
$env:LIVE_CANDIDATE_POOL_DB_PATH = (Join-Path $StateRoot "lightld-candidate-pool.sqlite")
$env:LIVE_QUOTE_URL = "http://127.0.0.1:$($env:SOLANA_EXECUTION_PORT)/quote"
$env:LIVE_SIGN_URL = "http://127.0.0.1:$($env:LIVE_LOCAL_SIGNER_PORT)/sign"
$env:LIVE_BROADCAST_URL = "http://127.0.0.1:$($env:SOLANA_EXECUTION_PORT)/broadcast"
$env:LIVE_CONFIRMATION_URL = "http://127.0.0.1:$($env:SOLANA_EXECUTION_PORT)/confirmation"
$env:LIVE_ACCOUNT_STATE_URL = "http://127.0.0.1:$($env:SOLANA_EXECUTION_PORT)/account-state"
$env:LIVE_MAX_ACTIVE_POSITIONS = [string]$MaxActivePositions
$env:LIVE_DAEMON_TICK_INTERVAL_MS = [string]$TickIntervalMs
$env:LIVE_DAEMON_HOT_TICK_INTERVAL_MS = [string]$HotTickIntervalMs

$signerHealthUrl = "http://127.0.0.1:$($env:LIVE_LOCAL_SIGNER_PORT)/health"
$deadline = (Get-Date).AddSeconds(60)
$signerReady = $false
while ((Get-Date) -lt $deadline) {
    try {
        $health = Invoke-RestMethod -UseBasicParsing -Uri $signerHealthUrl -TimeoutSec 3
        if ($health.status -eq "ok") {
            $signerReady = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $signerReady) {
    throw "Paper signer health check failed: $signerHealthUrl"
}

$executionHealthUrl = "http://127.0.0.1:$($env:SOLANA_EXECUTION_PORT)/health"
$deadline = (Get-Date).AddSeconds(60)
$executionReady = $false
while ((Get-Date) -lt $deadline) {
    try {
        $health = Invoke-RestMethod -UseBasicParsing -Uri $executionHealthUrl -TimeoutSec 3
        if ($health.status -eq "ok" -and $health.dryRun -eq $true) {
            $executionReady = $true
            break
        }
        if ($health.status -eq "ok" -and $health.dryRun -ne $true) {
            throw "execution service is not in dry-run mode"
        }
    } catch {
        if ($_.Exception.Message -like "*not in dry-run mode*") { throw }
        Start-Sleep -Milliseconds 500
    }
}
if (-not $executionReady) {
    throw "Paper execution health check failed or dryRun was not true: $executionHealthUrl"
}

function Get-PaperDaemonPositiveIntegerSetting {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [int]$DefaultValue,
        [Parameter(Mandatory = $true)]
        [int]$MinimumValue,
        [Parameter(Mandatory = $true)]
        [int]$MaximumValue
    )

    $parsedValue = 0
    $rawValue = [Environment]::GetEnvironmentVariable($Name)
    if (-not [int]::TryParse($rawValue, [ref]$parsedValue) -or $parsedValue -lt $MinimumValue) {
        return $DefaultValue
    }
    return [Math]::Min($MaximumValue, $parsedValue)
}

$daemonRestartDelayMs = Get-PaperDaemonPositiveIntegerSetting -Name "LIGHTLD_DAEMON_RESTART_DELAY_MS" -DefaultValue 5000 -MinimumValue 1000 -MaximumValue 300000
$daemonWatchdogPollMs = Get-PaperDaemonPositiveIntegerSetting -Name "LIGHTLD_DAEMON_WATCHDOG_POLL_MS" -DefaultValue 5000 -MinimumValue 1000 -MaximumValue 60000
$daemonStaleAfterMs = Get-PaperDaemonPositiveIntegerSetting -Name "LIGHTLD_DAEMON_WATCHDOG_STALE_AFTER_MS" -DefaultValue 300000 -MinimumValue 60000 -MaximumValue 1800000
$daemonLogDirectory = Join-Path $JournalRoot "component-logs"
New-Item -ItemType Directory -Force -Path $daemonLogDirectory | Out-Null
$daemonStdoutLog = Join-Path $daemonLogDirectory "paper-daemon.stdout.log"
$daemonStderrLog = Join-Path $daemonLogDirectory "paper-daemon.stderr.log"
$daemonSupervisorLog = Join-Path $daemonLogDirectory "paper-daemon-supervisor.log"

function Write-PaperDaemonSupervisorLog {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $line = "[{0}] [PaperRealistic] daemon {1}" -f (Get-Date).ToUniversalTime().ToString("o"), $Message
    Add-Content -LiteralPath $daemonSupervisorLog -Value $line -Encoding utf8
    Write-Host $line
}

function Test-PaperDaemonHeartbeatFresh {
    param(
        [Parameter(Mandatory = $true)]
        [string]$HealthPath,
        [Parameter(Mandatory = $true)]
        [datetime]$StartedAtUtc,
        [Parameter(Mandatory = $true)]
        [int]$StaleAfterMs
    )

    $now = (Get-Date).ToUniversalTime()
    if (($now - $StartedAtUtc).TotalMilliseconds -lt $StaleAfterMs) {
        return $true
    }

    try {
        $health = Get-Content -LiteralPath $HealthPath -Raw | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace([string]$health.lastSuccessfulTickAt)) {
            return $false
        }
        $lastSuccessfulTickAt = [datetime]::Parse([string]$health.lastSuccessfulTickAt).ToUniversalTime()
        if ($lastSuccessfulTickAt -lt $StartedAtUtc) {
            return $false
        }
        return (($now - $lastSuccessfulTickAt).TotalMilliseconds -lt $StaleAfterMs)
    } catch {
        return $false
    }
}

$daemonArguments = @(
    "run", "run:daemon", "--",
    "--strategy", $Strategy,
    "--state-root-dir", $StateRoot,
    "--journal-root-dir", $JournalRoot,
    "--max-active-positions", [string]$MaxActivePositions,
    "--tick-interval-ms", [string]$TickIntervalMs,
    "--hot-tick-interval-ms", [string]$HotTickIntervalMs
)
$daemonHealthPath = Join-Path $StateRoot "health.json"

while ($true) {
    $daemonStartedAtUtc = (Get-Date).ToUniversalTime()
    Write-PaperDaemonSupervisorLog "starting"
    try {
        $daemonProcess = Start-Process -FilePath "npm.cmd" -ArgumentList $daemonArguments -PassThru -NoNewWindow -RedirectStandardOutput $daemonStdoutLog -RedirectStandardError $daemonStderrLog
    } catch {
        Write-PaperDaemonSupervisorLog "failed to start: $($_.Exception.Message); retrying in ${daemonRestartDelayMs}ms"
        Start-Sleep -Milliseconds $daemonRestartDelayMs
        continue
    }

    $watchdogRestart = $false
    while (-not $daemonProcess.HasExited) {
        Start-Sleep -Milliseconds $daemonWatchdogPollMs
        $daemonProcess.Refresh()
        if (-not $daemonProcess.HasExited -and -not (Test-PaperDaemonHeartbeatFresh -HealthPath $daemonHealthPath -StartedAtUtc $daemonStartedAtUtc -StaleAfterMs $daemonStaleAfterMs)) {
            $watchdogRestart = $true
            Write-PaperDaemonSupervisorLog "heartbeat stale; terminating PID $($daemonProcess.Id)"
            & taskkill.exe /PID $daemonProcess.Id /T /F | Out-Null
            $daemonProcess.WaitForExit()
        }
    }

    $daemonProcess.Refresh()
    $exitCode = "unknown"
    try {
        $reportedExitCode = $daemonProcess.ExitCode
        if ($null -ne $reportedExitCode) {
            $exitCode = [string]$reportedExitCode
        }
    } catch {
        # taskkill can make the Windows Process API lose the child's exit code.
    }
    $exitReason = if ($watchdogRestart) { "watchdog restart" } else { "process exited" }
    Write-PaperDaemonSupervisorLog "$exitReason with code $exitCode; retrying in ${daemonRestartDelayMs}ms"
    Start-Sleep -Milliseconds $daemonRestartDelayMs
}
