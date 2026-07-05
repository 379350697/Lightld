param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$StateRoot = "state-paper-realistic",
    [string]$JournalRoot = "tmp/paper-realistic-journals",
    [int]$MaxActivePositions = 100000,
    [int]$TickIntervalMs = 10000,
    [int]$HotTickIntervalMs = 2000,
    [double]$RequestedPositionSol = 0.01
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path -LiteralPath $Root).Path
Set-Location $Root

$roles = @("signer", "execution", "daemon")
$started = @()
foreach ($role in $roles) {
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        (Join-Path $PSScriptRoot "run-paper-realistic-component.ps1"),
        "-Role",
        $role,
        "-Root",
        $Root,
        "-StateRoot",
        $StateRoot,
        "-JournalRoot",
        $JournalRoot,
        "-MaxActivePositions",
        [string]$MaxActivePositions,
        "-TickIntervalMs",
        [string]$TickIntervalMs,
        "-HotTickIntervalMs",
        [string]$HotTickIntervalMs,
        "-RequestedPositionSol",
        [string]$RequestedPositionSol
    )
    $process = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $arguments -PassThru
    $started += [pscustomobject]@{ role = $role; pid = $process.Id }
}

$started | ConvertTo-Json
