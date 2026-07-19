param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$StateRoot = "state-paper-realistic",
    [string]$JournalRoot = "tmp/paper-realistic-journals",
    [ValidateSet("new-token-v1", "large-pool-v1")]
    [string]$Strategy = "new-token-v1",
    [switch]$ForceRestart,
    [ValidateRange(5, 300)]
    [int]$CheckIntervalSeconds = 15,
    [ValidateRange(15, 300)]
    [int]$StartupGraceSeconds = 45,
    [int]$MaxActivePositions = 100,
    [int]$TickIntervalMs = 10000,
    [int]$HotTickIntervalMs = 2000
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path -LiteralPath $Root).Path
. (Join-Path $PSScriptRoot "lightld-process-records.ps1")
$StateRoot = Resolve-LightldPath -Root $Root -Path $StateRoot
$JournalRoot = Resolve-LightldPath -Root $Root -Path $JournalRoot
$logDirectory = Join-Path $JournalRoot "component-logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$supervisorLog = Join-Path $logDirectory "paper-system-supervisor.log"
$roles = @("signer", "gmgn", "execution", "candidate", "research", "daemon")
$launcher = Join-Path $PSScriptRoot "start-paper-realistic.ps1"

function Write-PaperSystemSupervisorLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $line = "[{0}] [PaperSystemSupervisor] {1}" -f (Get-Date).ToUniversalTime().ToString("o"), $Message
    Add-Content -LiteralPath $supervisorLog -Value $line -Encoding utf8
    Write-Host $line
}

function Test-PaperRoleProcess {
    param([Parameter(Mandatory = $true)][string]$Role)

    $recordPath = Join-Path (Get-LightldProcessRecordDirectory -Root $Root -StateRoot $StateRoot) "$Role.json"
    try {
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        if ($record.mode -ne "mechanical-soak" -or $record.role -ne $Role -or $record.root -ne $Root) {
            return $false
        }
        $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        return $process.ProcessName -eq $record.processName -and $process.StartTime.ToUniversalTime().Ticks -eq [long]$record.processStartedAtUtcTicks
    } catch {
        return $false
    }
}

function Start-PaperRuntime {
    Write-PaperSystemSupervisorLog "starting all paper components"
    & $launcher `
        -Root $Root `
        -StateRoot $StateRoot `
        -JournalRoot $JournalRoot `
        -Strategy $Strategy `
        -MaxActivePositions $MaxActivePositions `
        -TickIntervalMs $TickIntervalMs `
        -HotTickIntervalMs $HotTickIntervalMs
    if ($LASTEXITCODE -ne 0) {
        throw "Paper launcher exited with code $LASTEXITCODE"
    }
}

Write-PaperSystemSupervisorLog "started as $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
$forceRestartPending = $ForceRestart
while ($true) {
    $failedRoles = if ($forceRestartPending) {
        $forceRestartPending = $false
        Write-PaperSystemSupervisorLog "forced runtime restart requested"
        @($roles)
    } else {
        @($roles | Where-Object { -not (Test-PaperRoleProcess -Role $_) })
    }
    if ($failedRoles.Count -gt 0) {
        Write-PaperSystemSupervisorLog "unhealthy roles: $($failedRoles -join ', '); restarting runtime"
        try {
            Start-PaperRuntime
            Write-PaperSystemSupervisorLog "runtime launched; allowing ${StartupGraceSeconds}s startup grace"
            Start-Sleep -Seconds $StartupGraceSeconds
        } catch {
            Write-PaperSystemSupervisorLog "launcher failed: $($_.Exception.Message); retrying in ${CheckIntervalSeconds}s"
            Start-Sleep -Seconds $CheckIntervalSeconds
        }
        continue
    }
    Start-Sleep -Seconds $CheckIntervalSeconds
}
