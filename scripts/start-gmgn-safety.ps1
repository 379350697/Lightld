param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Continue"

. (Join-Path $Root "scripts/load-env.ps1") -Root $Root
Set-Location -LiteralPath $Root
New-Item -ItemType Directory -Force -Path (Join-Path $Root "logs") | Out-Null

$PythonBin = $env:GMGN_PYTHON_BIN
if (-not $PythonBin) { $PythonBin = "python" }

$LogPath = Join-Path $Root "logs/gmgn-safety.log"
$env:GMGN_SAFETY_LOG_PATH = $LogPath
$ServerScript = Join-Path $Root "scripts/gmgn-token-safety-server.py"

while ($true) {
    $StartMessage = "[{0}] Starting GMGN safety sidecar via Start-Process..." -f (Get-Date).ToString("o")
    Add-Content -LiteralPath $LogPath -Value $StartMessage -Encoding utf8
    Write-Host $StartMessage

    try {
        $Process = Start-Process -FilePath $PythonBin -ArgumentList @("-u", $ServerScript) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
        $Process.WaitForExit()
        $ExitCode = $Process.ExitCode
    } catch {
        $ExitCode = -999
        $ErrorMessage = "[{0}] Failed to start GMGN safety sidecar: {1}" -f (Get-Date).ToString("o"), $_.Exception.Message
        Add-Content -LiteralPath $LogPath -Value $ErrorMessage -Encoding utf8
        Write-Host $ErrorMessage
    }

    $Message = "[{0}] GMGN safety sidecar exited code={1}; restarting in 5s..." -f (Get-Date).ToString("o"), $ExitCode
    Add-Content -LiteralPath $LogPath -Value $Message -Encoding utf8
    Write-Host $Message
    Start-Sleep -Seconds 5
}
