param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("signer", "execution", "daemon")]
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

$Host.UI.RawUI.WindowTitle = "Lightld Paper Realistic $Role"

if ($Role -eq "signer") {
    npm.cmd run run:signer
    exit $LASTEXITCODE
}

if ($Role -eq "execution") {
    $env:SOLANA_EXECUTION_DRY_RUN = "true"
    $env:SOLANA_EXECUTION_STATE_DIR = (Join-Path $StateRoot "solana-execution")
    npm.cmd run run:solana-execution
    exit $LASTEXITCODE
}

$env:LIVE_EXECUTION_MODE = "http"
$env:LIVE_STATE_DIR = $StateRoot
$env:LIVE_JOURNAL_DIR = $JournalRoot
$env:LIVE_DB_MIRROR_PATH = (Join-Path $StateRoot "lightld-observability.sqlite")
$env:LIVE_CANDIDATE_POOL_DB_PATH = "state/lightld-candidate-pool.sqlite"
$env:LIVE_QUOTE_URL = "http://127.0.0.1:8791/quote"
$env:LIVE_SIGN_URL = "http://127.0.0.1:8788/sign"
$env:LIVE_BROADCAST_URL = "http://127.0.0.1:8791/broadcast"
$env:LIVE_CONFIRMATION_URL = "http://127.0.0.1:8791/confirmation"
$env:LIVE_ACCOUNT_STATE_URL = "http://127.0.0.1:8791/account-state"
$env:LIVE_REQUESTED_POSITION_SOL = [string]$RequestedPositionSol
$env:LIVE_DISABLE_DYNAMIC_POSITION_SIZING = "true"
$env:LIVE_MAX_ACTIVE_POSITIONS = [string]$MaxActivePositions
$env:LIVE_DAEMON_TICK_INTERVAL_MS = [string]$TickIntervalMs
$env:LIVE_DAEMON_HOT_TICK_INTERVAL_MS = [string]$HotTickIntervalMs

npm.cmd run run:daemon -- --strategy new-token-v1 --state-root-dir $StateRoot --journal-root-dir $JournalRoot --max-active-positions $MaxActivePositions --tick-interval-ms $TickIntervalMs --hot-tick-interval-ms $HotTickIntervalMs
exit $LASTEXITCODE
