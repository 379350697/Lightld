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

while ($true) {
    & $PythonBin -u (Join-Path $Root "scripts/gmgn-token-safety-server.py") 2>&1 |
        Tee-Object -FilePath $LogPath -Append
    $ExitCode = $LASTEXITCODE
    $Message = "[{0}] GMGN safety sidecar exited code={1}; restarting in 5s..." -f (Get-Date).ToString("o"), $ExitCode
    Add-Content -LiteralPath $LogPath -Value $Message
    Write-Host $Message
    Start-Sleep -Seconds 5
}
