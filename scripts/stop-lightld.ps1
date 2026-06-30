param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string[]]$Role = @("all")
)

$ErrorActionPreference = "Stop"

$AllRoles = @("signer", "execution", "gmgn", "candidate", "daemon", "dashboard")
if ($Role -contains "all") {
    $Role = $AllRoles
}

$RolePatterns = @{
    signer = @("run:signer", "local-live-signer")
    execution = @("run:execution", "run:solana-execution", "local-live-execution", "solana-execution")
    gmgn = @("gmgn-token-safety-server.py", "start-gmgn-safety.ps1", "lightld gmgn safety")
    candidate = @("run:candidate-worker", "candidate-worker")
    daemon = @("run:daemon", "live-daemon")
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
    $InThisProject = $CommandLine.Contains($RootNeedle) -or $CommandLine.Contains("lightld")
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

if ($TargetPids.Count -eq 0) {
    Write-Host "No old Lightld instances found for role(s): $($Role -join ', ')"
    exit 0
}

Stop-LightldProcessIds @($TargetPids)
