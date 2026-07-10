param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$StateRoot = "state-paper-realistic",
    [string]$JournalRoot = "tmp/paper-realistic-journals",
    [string]$LogRoot = "logs",
    [int]$MaxActivePositions = 100000,
    [int]$TickIntervalMs = 10000,
    [int]$HotTickIntervalMs = 2000,
    [double]$RequestedPositionSol = 1
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path -LiteralPath $Root).Path
Set-Location $Root
$LogRoot = Join-Path $Root $LogRoot
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

$stopScript = Join-Path $PSScriptRoot "stop-lightld.ps1"
foreach ($role in @("signer", "execution", "candidate", "daemon")) {
    & $stopScript -Root $Root -Role $role
}

$roles = @("signer", "execution", "candidate", "daemon")
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
    $stdoutPath = Join-Path $LogRoot "paper-realistic-$role.out.log"
    $stderrPath = Join-Path $LogRoot "paper-realistic-$role.err.log"
    $process = Start-Process powershell.exe `
        -WindowStyle Hidden `
        -ArgumentList $arguments `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
    $started += [pscustomobject]@{
        role = $role
        pid = $process.Id
        stdout = $stdoutPath
        stderr = $stderrPath
    }
}

$started | ConvertTo-Json
