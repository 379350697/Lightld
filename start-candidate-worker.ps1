$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts/load-env.ps1") -Root $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "scripts/stop-lightld.ps1") -Root $PSScriptRoot -Role candidate

$RootLiteral = "'" + $PSScriptRoot.Replace("'", "''") + "'"
$LoaderLiteral = "'" + (Join-Path $PSScriptRoot "scripts/load-env.ps1").Replace("'", "''") + "'"
$Command = @"
`$host.UI.RawUI.WindowTitle = 'Lightld Candidate Worker'
. $LoaderLiteral -Root $RootLiteral
Set-Location -LiteralPath $RootLiteral
New-Item -ItemType Directory -Force -Path (Join-Path (Get-Location) 'logs') | Out-Null
npm.cmd run run:candidate-worker -- --strategy new-token-v1 2>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'logs/candidate-worker.log') -Append
"@

Start-Process powershell.exe -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $Command) -WorkingDirectory $PSScriptRoot
Write-Host "Candidate worker started."
