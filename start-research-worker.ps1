param(
    [string]$StateRoot = $(if ($env:LIVE_STATE_DIR) { $env:LIVE_STATE_DIR } else { "state-paper-realistic" })
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
. (Join-Path $PSScriptRoot "scripts/lightld-process-records.ps1")
Set-Location -LiteralPath $PSScriptRoot
$StateRoot = Resolve-LightldPath -Root $PSScriptRoot -Path $StateRoot
$JournalRoot = Resolve-LightldPath -Root $PSScriptRoot -Path "tmp/paper-realistic-journals"
$env:LIGHTLD_RUN_MODE = "mechanical-soak"
$env:LIGHTLD_EXECUTION_MODE = "mechanical-soak"
$env:LIVE_STATE_DIR = $StateRoot
$LaunchLock = Enter-LightldLaunchLock -Root $PSScriptRoot -StateRoot $StateRoot
try {
    Assert-LightldStateRootMode -Root $PSScriptRoot -StateRoot $StateRoot -Mode "mechanical-soak"
    & (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -StateRoot $StateRoot -Role research

    $Arguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        (Join-Path $PSScriptRoot "scripts/run-paper-realistic-component.ps1"),
        "-Role", "research",
        "-Root", $PSScriptRoot,
        "-StateRoot", $StateRoot,
        "-JournalRoot", $JournalRoot
    )
    $Process = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $Arguments -PassThru
    Start-Sleep -Milliseconds 250
    $Process.Refresh()
    if ($Process.HasExited) {
        throw "Strategy research worker exited during startup with code $($Process.ExitCode)"
    }
    try {
        [void](Write-LightldProcessRecord -Root $PSScriptRoot -StateRoot $StateRoot -Role "research" -Mode "mechanical-soak" -Process $Process)
    } catch {
        & taskkill.exe /PID $Process.Id /T /F | Out-Null
        throw
    }
} finally {
    $LaunchLock.Dispose()
}
Write-Host "Strategy research worker started for $StateRoot (pid=$($Process.Id))"
