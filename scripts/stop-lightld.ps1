param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string[]]$Role = @("all")
)

$ErrorActionPreference = "Stop"

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

if ($env:LIVE_LOCAL_SIGNER_PORT) {
    $RolePorts.signer += @([int]$env:LIVE_LOCAL_SIGNER_PORT)
}
if ($env:SOLANA_EXECUTION_PORT) {
    $RolePorts.execution += @([int]$env:SOLANA_EXECUTION_PORT)
}
if ($env:GMGN_SAFETY_PORT) {
    $RolePorts.gmgn += @([int]$env:GMGN_SAFETY_PORT)
}
if ($env:DASHBOARD_PORT) {
    $RolePorts.dashboard += @([int]$env:DASHBOARD_PORT)
}

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

function Add-UniqueProcessId {
    param(
        [System.Collections.Generic.HashSet[int]]$Set,
        [int]$ProcessId
    )

    if ($ProcessId -gt 0 -and -not $ProtectedPids.Contains($ProcessId)) {
        [void]$Set.Add($ProcessId)
    }
}

function Stop-LightldProcessIds {
    param([int[]]$ProcessIds)

    foreach ($ProcessId in ($ProcessIds | Sort-Object -Unique)) {
        try {
            $Process = Get-Process -Id $ProcessId -ErrorAction Stop
            Write-Host "Stopping old Lightld process: pid=$ProcessId name=$($Process.ProcessName)"
            Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Host "Skip process pid=${ProcessId}: already stopped or inaccessible"
        }
    }
}

function Add-DescendantProcessIds {
    param(
        [System.Collections.Generic.HashSet[int]]$Set,
        $Processes
    )

    $Added = $true
    while ($Added) {
        $Added = $false
        foreach ($Process in $Processes) {
            if (-not $Process.ProcessId -or -not $Process.ParentProcessId) { continue }
            $ProcessId = [int]$Process.ProcessId
            $ParentProcessId = [int]$Process.ParentProcessId
            if ($Set.Contains($ParentProcessId) -and -not $Set.Contains($ProcessId) -and -not $ProtectedPids.Contains($ProcessId)) {
                [void]$Set.Add($ProcessId)
                $Added = $true
            }
        }
    }
}

$RootNeedle = $Root.ToLowerInvariant()
$TargetPids = [System.Collections.Generic.HashSet[int]]::new()

foreach ($CurrentRole in $Role) {
    if (-not $RolePatterns.ContainsKey($CurrentRole)) {
        Write-Host "Unknown Lightld role '$CurrentRole', skipping"
        continue
    }

    foreach ($Port in ($RolePorts[$CurrentRole] | ForEach-Object { $_ })) {
        try {
            $Connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
            foreach ($Connection in $Connections) {
                Add-UniqueProcessId $TargetPids ([int]$Connection.OwningProcess)
            }
        } catch {
            Write-Host "Port scan unavailable for $Port, continuing with command-line scan"
        }
    }
}

$Processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
foreach ($Process in $Processes) {
    if (-not $Process.CommandLine) { continue }

    $CommandLine = $Process.CommandLine.ToLowerInvariant()
    $InThisProject = $CommandLine.Contains($RootNeedle) `
        -or $CommandLine.Contains("lightld") `
        -or $CommandLine.Contains("run-paper-realistic-component.ps1") `
        -or $CommandLine.Contains("run-live-daemon-main") `
        -or $CommandLine.Contains("candidate-worker") `
        -or $CommandLine.Contains("solana-execution-server") `
        -or $CommandLine.Contains("local-live-signer")
    if (-not $InThisProject) { continue }

    foreach ($CurrentRole in $Role) {
        if (-not $RolePatterns.ContainsKey($CurrentRole)) { continue }
        foreach ($Pattern in $RolePatterns[$CurrentRole]) {
            if ($CommandLine.Contains($Pattern.ToLowerInvariant())) {
                Add-UniqueProcessId $TargetPids ([int]$Process.ProcessId)
            }
        }
    }
}

Add-DescendantProcessIds $TargetPids $Processes

if ($TargetPids.Count -eq 0) {
    Write-Host "No old Lightld instances found for role(s): $($Role -join ', ')"
    exit 0
}

Stop-LightldProcessIds @($TargetPids)
