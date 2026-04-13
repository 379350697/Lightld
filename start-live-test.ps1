$ErrorActionPreference = "Stop"

# ── Proxy configuration (bypass GFW for Jupiter / Meteora API) ──
$ProxyUrl = $env:HTTP_PROXY
if (-not $ProxyUrl) { $ProxyUrl = "http://127.0.0.1:7897" }
$ProxyEnv = "`$env:HTTP_PROXY='$ProxyUrl'; `$env:HTTPS_PROXY='$ProxyUrl'; "

Write-Host "Using proxy: $ProxyUrl"

Write-Host "Starting Signer Service..."
Start-Process powershell -ArgumentList "-Title `"Lightld Signer`" -NoExit -Command `"${ProxyEnv}`$env:LIVE_LOCAL_SIGNER_KEYPAIR_PATH='D:\codex\Lightld\secrets\burner.json'; `$env:LIVE_LOCAL_SIGNER_PORT='8787'; npm run run:signer`"" -WorkingDirectory 'D:\codex\Lightld'

Start-Sleep -Seconds 2

Write-Host "Starting Execution Service..."
Start-Process powershell -ArgumentList "-Title `"Lightld Execution`" -NoExit -Command `"${ProxyEnv}`$env:LIVE_LOCAL_EXECUTION_STATE_DIR='state\local-execution'; `$env:LIVE_LOCAL_EXECUTION_ACCOUNT_STATE_PATH='state\account-state.json'; `$env:LIVE_LOCAL_EXECUTION_PORT='8790'; npm run run:execution`"" -WorkingDirectory 'D:\codex\Lightld'

Start-Sleep -Seconds 3

Write-Host "Starting Daemon Service..."
Start-Process powershell -ArgumentList "-Title `"Lightld Daemon`" -NoExit -Command `"${ProxyEnv}`$env:LIVE_AUTH_TOKEN='replace-me'; `$env:LIVE_SIGN_URL='http://127.0.0.1:8787/sign'; `$env:LIVE_BROADCAST_URL='http://127.0.0.1:8790/broadcast'; `$env:LIVE_CONFIRMATION_URL='http://127.0.0.1:8790/confirmation'; `$env:LIVE_ACCOUNT_STATE_URL='http://127.0.0.1:8790/account-state'; `$env:LIVE_WHITELIST='Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump'; `$env:LIVE_REQUESTED_POSITION_SOL='0.01'; npm run run:daemon -- --strategy new-token-v1`"" -WorkingDirectory 'D:\codex\Lightld'

Write-Host "All services started in new windows! (proxy: $ProxyUrl)"
