function Resolve-LightldPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $Root $Path))
}

function Get-LightldProcessRecordDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string]$StateRoot
    )

    $ResolvedStateRoot = Resolve-LightldPath -Root $Root -Path $StateRoot
    return Join-Path $ResolvedStateRoot ".lightld-processes"
}

function Assert-LightldStateRootMode {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string]$StateRoot,
        [Parameter(Mandatory = $true)]
        [ValidateSet("mechanical-soak", "live")]
        [string]$Mode
    )

    $ResolvedStateRoot = Resolve-LightldPath -Root $Root -Path $StateRoot
    New-Item -ItemType Directory -Force -Path $ResolvedStateRoot | Out-Null
    $MarkerPath = Join-Path $ResolvedStateRoot ".lightld-run-mode"
    if (Test-Path -LiteralPath $MarkerPath -PathType Leaf) {
        $ExistingMode = (Get-Content -LiteralPath $MarkerPath -Raw).Trim()
        if ($ExistingMode -and $ExistingMode -ne $Mode) {
            throw "StateRoot '$ResolvedStateRoot' belongs to '$ExistingMode', not '$Mode'"
        }
    }
    $TemporaryPath = "$MarkerPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    Set-Content -LiteralPath $TemporaryPath -Value $Mode -Encoding ascii
    Move-Item -LiteralPath $TemporaryPath -Destination $MarkerPath -Force
}

function Write-LightldProcessRecord {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string]$StateRoot,
        [Parameter(Mandatory = $true)]
        [string]$Role,
        [Parameter(Mandatory = $true)]
        [ValidateSet("mechanical-soak", "live")]
        [string]$Mode,
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process
    )

    $ResolvedRoot = (Resolve-Path -LiteralPath $Root).Path
    $ResolvedStateRoot = Resolve-LightldPath -Root $ResolvedRoot -Path $StateRoot
    $RecordDirectory = Get-LightldProcessRecordDirectory -Root $ResolvedRoot -StateRoot $ResolvedStateRoot
    New-Item -ItemType Directory -Force -Path $RecordDirectory | Out-Null

    $Process.Refresh()
    $Record = [ordered]@{
        version = 1
        platform = "windows"
        root = $ResolvedRoot
        stateRoot = $ResolvedStateRoot
        role = $Role
        mode = $Mode
        pid = [int]$Process.Id
        processName = $Process.ProcessName
        processStartedAtUtcTicks = [long]$Process.StartTime.ToUniversalTime().Ticks
        recordedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }

    $RecordPath = Join-Path $RecordDirectory "$Role.json"
    $TemporaryPath = "$RecordPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $Record | ConvertTo-Json | Set-Content -LiteralPath $TemporaryPath -Encoding utf8
    Move-Item -LiteralPath $TemporaryPath -Destination $RecordPath -Force
    return $RecordPath
}

function Enter-LightldLaunchLock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string]$StateRoot
    )

    $RecordDirectory = Get-LightldProcessRecordDirectory -Root $Root -StateRoot $StateRoot
    New-Item -ItemType Directory -Force -Path $RecordDirectory | Out-Null
    $LockPath = Join-Path $RecordDirectory "launch.lock"
    try {
        return [System.IO.File]::Open(
            $LockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch {
        throw "Another Lightld launcher is already starting for StateRoot '$StateRoot'"
    }
}

function Enter-LightldRoleLock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string]$StateRoot,
        [Parameter(Mandatory = $true)]
        [string]$Role
    )

    $RecordDirectory = Get-LightldProcessRecordDirectory -Root $Root -StateRoot $StateRoot
    New-Item -ItemType Directory -Force -Path $RecordDirectory | Out-Null
    $LockPath = Join-Path $RecordDirectory "$Role.lock"
    try {
        return [System.IO.File]::Open(
            $LockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch {
        throw "A Lightld '$Role' process is already running for StateRoot '$StateRoot'"
    }
}
