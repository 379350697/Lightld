param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("signer", "execution", "candidate", "research", "daemon")]
    [string]$Role,
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$StateRoot = "state-paper-realistic",
    [string]$JournalRoot = "tmp/paper-realistic-journals",
    [int]$MaxActivePositions = 100000,
    [int]$TickIntervalMs = 10000,
    [int]$HotTickIntervalMs = 2000,
    [double]$RequestedPositionSol = 1
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path -LiteralPath $Root).Path
Set-Location $Root
& (Join-Path $PSScriptRoot "load-env.ps1") -Root $Root
$env:LIGHTLD_RUN_MODE = "mechanical-soak"
$env:LIGHTLD_EXECUTION_MODE = "mechanical-soak"
$env:SOLANA_EXECUTION_DRY_RUN = "true"

$Host.UI.RawUI.WindowTitle = "Lightld Paper Realistic $Role"
$env:LIVE_LOCAL_SIGNER_MAX_OUTPUT_SOL = "1000000"
$env:LIVE_LOCAL_EXECUTION_MAX_OUTPUT_SOL = "1000000"
$env:SOLANA_MAX_OUTPUT_SOL = "1000000"

if ($Role -eq "signer") {
    npm.cmd run run:signer
    exit $LASTEXITCODE
}

if ($Role -eq "execution") {
    $env:SOLANA_EXECUTION_STATE_DIR = (Join-Path $StateRoot "solana-execution")
    npm.cmd run run:solana-execution
    exit $LASTEXITCODE
}

if ($Role -eq "candidate") {
    $env:LIVE_STATE_DIR = $StateRoot
    $env:LIVE_CANDIDATE_POOL_DB_PATH = (Join-Path $StateRoot "lightld-candidate-pool.sqlite")
    $env:LIVE_REQUESTED_POSITION_SOL = [string]$RequestedPositionSol
    $restartDelayMs = 5000
    $parsedRestartDelayMs = 0
    if ([int]::TryParse($env:LIVE_CANDIDATE_WORKER_RESTART_DELAY_MS, [ref]$parsedRestartDelayMs) -and $parsedRestartDelayMs -gt 0) {
        $restartDelayMs = $parsedRestartDelayMs
    }

    while ($true) {
        $startedAt = (Get-Date).ToUniversalTime().ToString("o")
        Write-Host "[PaperRealistic] candidate worker starting at $startedAt"
        npm.cmd run run:candidate-worker -- --strategy new-token-v1 --state-root-dir $StateRoot --db-path $env:LIVE_CANDIDATE_POOL_DB_PATH
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

$env:LIVE_EXECUTION_MODE = "http"
$env:LIVE_STATE_DIR = $StateRoot
$env:LIVE_JOURNAL_DIR = $JournalRoot
$env:LIVE_DB_MIRROR_PATH = (Join-Path $StateRoot "lightld-observability.sqlite")
$env:LIVE_CANDIDATE_POOL_DB_PATH = (Join-Path $StateRoot "lightld-candidate-pool.sqlite")
$env:LIVE_QUOTE_URL = "http://127.0.0.1:8791/quote"
$env:LIVE_SIGN_URL = "http://127.0.0.1:8788/sign"
$env:LIVE_BROADCAST_URL = "http://127.0.0.1:8791/broadcast"
$env:LIVE_CONFIRMATION_URL = "http://127.0.0.1:8791/confirmation"
$env:LIVE_ACCOUNT_STATE_URL = "http://127.0.0.1:8791/account-state"
$env:LIVE_REQUESTED_POSITION_SOL = [string]$RequestedPositionSol
$env:LIVE_DISABLE_DYNAMIC_POSITION_SIZING = "true"
$env:LIVE_IGNORE_POSITION_SOL_LIMIT = "true"
$env:LIVE_IGNORE_SPENDING_LIMITS = "true"
$env:LIVE_MAX_ACTIVE_POSITIONS = [string]$MaxActivePositions
$env:LIVE_DAEMON_TICK_INTERVAL_MS = [string]$TickIntervalMs
$env:LIVE_DAEMON_HOT_TICK_INTERVAL_MS = [string]$HotTickIntervalMs

npm.cmd run run:daemon -- --strategy new-token-v1 --state-root-dir $StateRoot --journal-root-dir $JournalRoot --max-active-positions $MaxActivePositions --tick-interval-ms $TickIntervalMs --hot-tick-interval-ms $HotTickIntervalMs
exit $LASTEXITCODE
