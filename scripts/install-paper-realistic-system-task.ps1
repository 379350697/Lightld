param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$StateRoot = "state-paper-realistic",
    [string]$JournalRoot = "tmp/paper-realistic-journals",
    [ValidateSet("new-token-v1", "large-pool-v1")]
    [string]$Strategy = "new-token-v1",
    [ValidateRange(1, 100)]
    [int]$MaxActivePositions = 100,
    [string]$TaskName = "Lightld Paper Realistic"
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Administrator privileges are required to install the SYSTEM paper supervisor task."
}

$Root = (Resolve-Path -LiteralPath $Root).Path
$supervisor = Join-Path $PSScriptRoot "run-paper-realistic-system-supervisor.ps1"
if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) {
    throw "Paper system supervisor script not found: $supervisor"
}

function Quote-TaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

$powershellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", (Quote-TaskArgument -Value $supervisor),
    "-Root", (Quote-TaskArgument -Value $Root),
    "-StateRoot", (Quote-TaskArgument -Value $StateRoot),
    "-JournalRoot", (Quote-TaskArgument -Value $JournalRoot),
    "-Strategy", (Quote-TaskArgument -Value $Strategy),
    "-MaxActivePositions", [string]$MaxActivePositions
) -join " "

$xmlCommand = [Security.SecurityElement]::Escape($powershellPath)
$xmlArguments = [Security.SecurityElement]::Escape($arguments)
$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>System-level supervisor for the Lightld paper runtime.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="System">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="System">
    <Exec>
      <Command>$xmlCommand</Command>
      <Arguments>$xmlArguments</Arguments>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = Join-Path ([System.IO.Path]::GetTempPath()) ("lightld-paper-task-" + [Guid]::NewGuid().ToString("N") + ".xml")
try {
    [System.IO.File]::WriteAllText($xmlPath, $taskXml, [System.Text.UnicodeEncoding]::new($false, $true))
    & schtasks.exe /Create /TN $TaskName /XML $xmlPath /F | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "schtasks.exe failed to register '$TaskName' with exit code $LASTEXITCODE"
    }
} finally {
    Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue
}

& schtasks.exe /Run /TN $TaskName | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "schtasks.exe failed to start '$TaskName' with exit code $LASTEXITCODE"
}
