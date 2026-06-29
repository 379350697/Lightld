param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

function Import-DotEnv {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }

    foreach ($Line in Get-Content -LiteralPath $Path) {
        $Trimmed = $Line.Trim()
        if (-not $Trimmed -or $Trimmed.StartsWith("#")) { continue }
        $EqualsIndex = $Trimmed.IndexOf("=")
        if ($EqualsIndex -lt 1) { continue }

        $Name = $Trimmed.Substring(0, $EqualsIndex).Trim()
        $Value = $Trimmed.Substring($EqualsIndex + 1).Trim()
        if (($Value.StartsWith('"') -and $Value.EndsWith('"')) -or ($Value.StartsWith("'") -and $Value.EndsWith("'"))) {
            $Value = $Value.Substring(1, $Value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
    }
}

Import-DotEnv (Join-Path $Root ".env")
Import-DotEnv (Join-Path $Root ".env.local")
Import-DotEnv (Join-Path $Root ".env.windows.local")

if ((-not $env:HTTP_PROXY -or $env:HTTP_PROXY -eq "http://127.0.0.1:9") -and $env:LIGHTLD_DEFAULT_PROXY) {
    $env:HTTP_PROXY = $env:LIGHTLD_DEFAULT_PROXY
    $env:HTTPS_PROXY = $env:LIGHTLD_DEFAULT_PROXY
}
