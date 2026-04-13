$ErrorActionPreference = "Stop"

# ── Proxy configuration (bypass GFW for Jupiter / Meteora API) ──
$ProxyUrl = $env:HTTP_PROXY
if (-not $ProxyUrl) { $ProxyUrl = "http://127.0.0.1:7897" }
$ProxyEnv = "`$env:HTTP_PROXY='$ProxyUrl'; `$env:HTTPS_PROXY='$ProxyUrl'; "

Write-Host "Starting Solana Mainnet Execution Service... (proxy: $ProxyUrl)"
Start-Process powershell -ArgumentList "-Title `"Solana Mainnet Execution`" -NoExit -Command `"${ProxyEnv}`$env:SOLANA_KEYPAIR_PATH='D:\codex\Lightld\secrets\burner.json'; `$env:SOLANA_EXECUTION_PORT='8791'; `$env:SOLANA_EXECUTION_AUTH_TOKEN='replace-me'; npm run run:solana-execution`"" -WorkingDirectory 'D:\codex\Lightld'

Write-Host "Service started on port 8791."
