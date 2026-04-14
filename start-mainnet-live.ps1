$ErrorActionPreference = "Stop"

# ── 代理配置 ──
$ProxyUrl = $env:HTTP_PROXY
if (-not $ProxyUrl) { $ProxyUrl = "http://127.0.0.1:7897" }
$ProxyEnv = "`$env:HTTP_PROXY='$ProxyUrl'; `$env:HTTPS_PROXY='$ProxyUrl'; "

Write-Host "========================================"
Write-Host "  Lightld Mainnet Live Trading"
Write-Host "  Proxy: $ProxyUrl"
Write-Host "========================================"

# ── Step 1: Signer (8787) ──
Write-Host "`n[1/3] Starting Signer Service (port 8787)..."
Start-Process powershell -ArgumentList "-NoExit -Command `"${ProxyEnv}`$env:LIVE_LOCAL_SIGNER_KEYPAIR_PATH='D:\codex\Lightld\secrets\burner.json'; `$env:LIVE_LOCAL_SIGNER_PORT='8787'; npm run run:signer`"" -WorkingDirectory 'D:\codex\Lightld'

Start-Sleep -Seconds 3

# ── Step 2: Solana Execution (8791) ──
Write-Host "[2/3] Starting Solana Execution Service (port 8791)..."
Start-Process powershell -ArgumentList "-NoExit -Command `"${ProxyEnv}`$env:SOLANA_KEYPAIR_PATH='D:\codex\Lightld\secrets\burner.json'; `$env:SOLANA_EXECUTION_PORT='8791'; `$env:SOLANA_EXECUTION_AUTH_TOKEN='replace-me'; `$env:SOLANA_MAX_OUTPUT_SOL='0.05'; `$env:JITO_TIP_LAMPORTS='25000'; `$env:SOLANA_DEFAULT_SLIPPAGE_BPS='100'; npm run run:solana-execution`"" -WorkingDirectory 'D:\codex\Lightld'

Start-Sleep -Seconds 5

# ── Step 3: Daemon (auto strategy) ──
Write-Host "[3/3] Starting Daemon (strategy auto-cycle)..."
$DaemonCmd = "${ProxyEnv}" +
    "`$env:LIVE_EXECUTION_MODE='http'; " +
    "`$env:LIVE_AUTH_TOKEN='replace-me'; " +
    "`$env:LIVE_SIGN_URL='http://127.0.0.1:8787/sign'; " +
    "`$env:LIVE_QUOTE_URL='http://127.0.0.1:8791/quote'; " +
    "`$env:LIVE_BROADCAST_URL='http://127.0.0.1:8791/broadcast'; " +
    "`$env:LIVE_CONFIRMATION_URL='http://127.0.0.1:8791/confirmation'; " +
    "`$env:LIVE_ACCOUNT_STATE_URL='http://127.0.0.1:8791/account-state'; " +
    "`$env:LIVE_REQUESTED_POSITION_SOL='0.01'; " +
    "`$env:LIVE_MAX_SINGLE_ORDER_SOL='0.05'; " +
    "`$env:LIVE_MAX_DAILY_SPEND_SOL='0.2'; " +
    "`$env:LIVE_METEORA_SORT_BY='fee_tvl_ratio_24h:desc'; " +
    "`$env:LIVE_METEORA_FILTER_BY='tvl>=10000 && is_blacklisted=false'; " +
    "`$env:LIVE_METEORA_PAGE_SIZE='50'; " +
    "npm run run:daemon -- --strategy new-token-v1"

Start-Process powershell -ArgumentList "-NoExit -Command `"$DaemonCmd`"" -WorkingDirectory 'D:\codex\Lightld'

Write-Host "`n========================================"
Write-Host "  All services started!"
Write-Host "  Signer:    http://127.0.0.1:8787"
Write-Host "  Execution: http://127.0.0.1:8791"
Write-Host "  Daemon:    auto strategy loop"
Write-Host "========================================"
Write-Host "  Limits: 0.05 SOL/order, 0.2 SOL/day"
