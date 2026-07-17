param(
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
$ProcessRecordHelpers = Join-Path $PSScriptRoot "lightld-process-records.ps1"
. $ProcessRecordHelpers
$StateRoot = Resolve-LightldPath -Root $Root -Path $StateRoot
$JournalRoot = Resolve-LightldPath -Root $Root -Path $JournalRoot
New-Item -ItemType Directory -Force -Path $StateRoot, $JournalRoot | Out-Null
Set-Location $Root

$stopScript = Join-Path $PSScriptRoot "stop-lightld.ps1"
$roles = @("signer", "gmgn", "execution", "candidate", "research", "daemon")
$started = @()
$LaunchLock = Enter-LightldLaunchLock -Root $Root -StateRoot $StateRoot
try {
    Assert-LightldStateRootMode -Root $Root -StateRoot $StateRoot -Mode "mechanical-soak"
    & $stopScript -Root $Root -StateRoot $StateRoot -Role all
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
            "-Strategy",
            $Strategy,
            "-MaxActivePositions",
            [string]$MaxActivePositions,
            "-TickIntervalMs",
            [string]$TickIntervalMs,
            "-HotTickIntervalMs",
            [string]$HotTickIntervalMs
        )
        $process = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $arguments -PassThru
        Start-Sleep -Milliseconds 250
        $process.Refresh()
        if ($process.HasExited) {
            throw "Paper $role component exited during startup with code $($process.ExitCode)"
        }
        try {
            [void](Write-LightldProcessRecord -Root $Root -StateRoot $StateRoot -Role $role -Mode "mechanical-soak" -Process $process)
        } catch {
            & taskkill.exe /PID $process.Id /T /F | Out-Null
            throw
        }
        $started += [pscustomobject]@{ role = $role; pid = $process.Id }
    }
} catch {
    & $stopScript -Root $Root -StateRoot $StateRoot -Role ($started.role)
    throw
} finally {
    $LaunchLock.Dispose()
}

$started | ConvertTo-Json
