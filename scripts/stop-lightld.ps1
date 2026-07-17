param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string[]]$Role = @("all"),
    [string]$StateRoot
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path -LiteralPath $Root).Path
. (Join-Path $PSScriptRoot "lightld-process-records.ps1")

$AllRoles = @("signer", "execution", "gmgn", "candidate", "research", "daemon", "dashboard")
if ($Role -contains "all") {
    $Role = $AllRoles
}

$RolePatterns = @{
    signer = @("run:signer", "local-live-signer", "run-paper-realistic-component.ps1 -role signer")
    execution = @("run:execution", "run:solana-execution", "local-live-execution", "solana-execution", "run-paper-realistic-component.ps1 -role execution")
    gmgn = @("gmgn-token-safety-server.py", "start-gmgn-safety.ps1", "lightld gmgn safety")
    candidate = @("run:candidate-worker", "candidate-worker", "run-paper-realistic-component.ps1 -role candidate")
    research = @("run:research-worker", "run-research-worker-main", "run-paper-realistic-component.ps1 -role research")
    daemon = @("run:daemon", "live-daemon", "run-live-daemon-main", "run-paper-realistic-component.ps1 -role daemon")
    dashboard = @("run:dashboard", "dashboard-server")
}

$RolePorts = @{
    signer = @(8787, 8788)
    execution = @(8790, 8791)
    gmgn = @(8898)
    dashboard = @(8899)
}

if ($env:LIVE_LOCAL_SIGNER_PORT) { $RolePorts.signer += @([int]$env:LIVE_LOCAL_SIGNER_PORT) }
if ($env:SOLANA_EXECUTION_PORT) { $RolePorts.execution += @([int]$env:SOLANA_EXECUTION_PORT) }
if ($env:GMGN_SAFETY_PORT) { $RolePorts.gmgn += @([int]$env:GMGN_SAFETY_PORT) }
if ($env:DASHBOARD_PORT) { $RolePorts.dashboard += @([int]$env:DASHBOARD_PORT) }

$ProtectedPids = [System.Collections.Generic.HashSet[int]]::new()
$CurrentProtectedPid = [int]$PID
while ($CurrentProtectedPid -gt 0 -and -not $ProtectedPids.Contains($CurrentProtectedPid)) {
    [void]$ProtectedPids.Add($CurrentProtectedPid)
    try {
        $CurrentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $CurrentProtectedPid" -ErrorAction Stop
        $CurrentProtectedPid = [int]$CurrentProcess.ParentProcessId
    } catch {
        break
    }
}

function Test-SelectedRole {
    param([string]$CandidateRole)
    return $Role -contains $CandidateRole
}

function Stop-VerifiedProcessTree {
    param(
        [int]$ProcessId,
        [string]$ExpectedProcessName,
        [long]$ExpectedStartedAtUtcTicks,
        [string]$Description
    )

    if ($ProcessId -le 0 -or $ProtectedPids.Contains($ProcessId)) {
        Write-Warning "Refusing to stop protected or invalid process for $Description (pid=$ProcessId)"
        return $false
    }

    try {
        $Process = Get-Process -Id $ProcessId -ErrorAction Stop
    } catch {
        Write-Host "Recorded Lightld process is already stopped: $Description pid=$ProcessId"
        return $true
    }

    try {
        $ActualStartedAtUtcTicks = [long]$Process.StartTime.ToUniversalTime().Ticks
    } catch {
        Write-Warning "Cannot verify process start time; refusing to stop $Description pid=$ProcessId"
        return $false
    }

    if ($ExpectedStartedAtUtcTicks -gt 0 -and $ActualStartedAtUtcTicks -ne $ExpectedStartedAtUtcTicks) {
        Write-Warning "PID was reused; refusing to stop $Description pid=$ProcessId"
        return $false
    }
    if ($ExpectedProcessName -and $Process.ProcessName -ne $ExpectedProcessName) {
        Write-Warning "Process name changed; refusing to stop $Description pid=$ProcessId"
        return $false
    }

    Write-Host "Stopping Lightld process tree: $Description pid=$ProcessId name=$($Process.ProcessName)"
    & taskkill.exe /PID $ProcessId /T /F | Out-Host
    if ($LASTEXITCODE -ne 0) {
        try {
            Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
            Write-Warning "Failed to stop $Description pid=$ProcessId"
            return $false
        } catch {
            return $true
        }
    }
    return $true
}

function Get-ProcessRecordDirectories {
    $Directories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    if ($StateRoot) {
        [void]$Directories.Add((Get-LightldProcessRecordDirectory -Root $Root -StateRoot $StateRoot))
        return @($Directories)
    }

    foreach ($CandidateStateRoot in @($env:LIVE_STATE_DIR, "state", "state-paper-realistic")) {
        if ($CandidateStateRoot) {
            [void]$Directories.Add((Get-LightldProcessRecordDirectory -Root $Root -StateRoot $CandidateStateRoot))
        }
    }
    foreach ($Child in (Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue)) {
        $CandidateDirectory = Join-Path $Child.FullName ".lightld-processes"
        if (Test-Path -LiteralPath $CandidateDirectory -PathType Container) {
            [void]$Directories.Add($CandidateDirectory)
        }
    }
    return @($Directories)
}

$ManagedRecordFound = $false
foreach ($RecordDirectory in (Get-ProcessRecordDirectories)) {
    if (-not (Test-Path -LiteralPath $RecordDirectory -PathType Container)) { continue }
    foreach ($RecordPath in (Get-ChildItem -LiteralPath $RecordDirectory -Filter "*.json" -File -ErrorAction SilentlyContinue)) {
        try {
            $Record = Get-Content -LiteralPath $RecordPath.FullName -Raw | ConvertFrom-Json
        } catch {
            Write-Warning "Ignoring invalid Lightld process record: $($RecordPath.FullName)"
            continue
        }

        if ($Record.platform -ne "windows" -or -not (Test-SelectedRole ([string]$Record.role))) { continue }
        if (-not [string]::Equals([string]$Record.root, $Root, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-Warning "Ignoring process record owned by another project root: $($RecordPath.FullName)"
            continue
        }

        $ManagedRecordFound = $true
        $Stopped = Stop-VerifiedProcessTree `
            -ProcessId ([int]$Record.pid) `
            -ExpectedProcessName ([string]$Record.processName) `
            -ExpectedStartedAtUtcTicks ([long]$Record.processStartedAtUtcTicks) `
            -Description "$($Record.mode)/$($Record.role)"
        if ($Stopped) {
            Remove-Item -LiteralPath $RecordPath.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}

# Compatibility cleanup for launchers created before PID records existed. This path
# is deliberately fail-closed: a process must expose a command line containing both
# this exact repository root and a role-specific command. Ports alone never authorize
# killing a process.
$Processes = @()
try {
    $Processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
    Write-Host "Windows command-line inspection is unavailable; skipped unverified legacy processes"
}

$RootNeedle = $Root.ToLowerInvariant()
$LegacyPids = [System.Collections.Generic.HashSet[int]]::new()
foreach ($Process in $Processes) {
    if (-not $Process.CommandLine) { continue }
    $CommandLine = $Process.CommandLine.ToLowerInvariant()
    if (-not $CommandLine.Contains($RootNeedle)) { continue }
    foreach ($CurrentRole in $Role) {
        if (-not $RolePatterns.ContainsKey($CurrentRole)) { continue }
        foreach ($Pattern in $RolePatterns[$CurrentRole]) {
            if ($CommandLine.Contains($Pattern.ToLowerInvariant())) {
                $CandidatePid = [int]$Process.ProcessId
                if ($CandidatePid -gt 0 -and -not $ProtectedPids.Contains($CandidatePid)) {
                    [void]$LegacyPids.Add($CandidatePid)
                }
                break
            }
        }
    }
}

foreach ($CurrentRole in $Role) {
    if (-not $RolePorts.ContainsKey($CurrentRole)) { continue }
    foreach ($Port in ($RolePorts[$CurrentRole] | Sort-Object -Unique)) {
        try {
            foreach ($Connection in (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)) {
                $OwningProcess = $Processes | Where-Object { [int]$_.ProcessId -eq [int]$Connection.OwningProcess } | Select-Object -First 1
                if (-not $OwningProcess -or -not $OwningProcess.CommandLine) { continue }
                $CommandLine = $OwningProcess.CommandLine.ToLowerInvariant()
                $MatchesRole = $false
                foreach ($Pattern in $RolePatterns[$CurrentRole]) {
                    if ($CommandLine.Contains($Pattern.ToLowerInvariant())) { $MatchesRole = $true; break }
                }
                if ($CommandLine.Contains($RootNeedle) -and $MatchesRole) {
                    [void]$LegacyPids.Add([int]$Connection.OwningProcess)
                }
            }
        } catch {
            Write-Host "Port inspection unavailable for $Port; skipped unverified listener"
        }
    }
}

foreach ($LegacyPid in @($LegacyPids)) {
    try {
        $LegacyProcess = Get-Process -Id $LegacyPid -ErrorAction Stop
        $LegacyStartedAtUtcTicks = [long]$LegacyProcess.StartTime.ToUniversalTime().Ticks
        [void](Stop-VerifiedProcessTree `
            -ProcessId $LegacyPid `
            -ExpectedProcessName $LegacyProcess.ProcessName `
            -ExpectedStartedAtUtcTicks $LegacyStartedAtUtcTicks `
            -Description "verified legacy Lightld process")
    } catch {
        Write-Host "Legacy Lightld process already stopped: pid=$LegacyPid"
    }
}

if (-not $ManagedRecordFound -and $LegacyPids.Count -eq 0) {
    Write-Host "No verified Lightld instances found for role(s): $($Role -join ', ')"
}
