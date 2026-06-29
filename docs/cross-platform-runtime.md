# Cross-platform runtime configuration

Lightld loads environment files in this order:

1. `.env`
2. `.env.local`
3. `.env.windows.local` on PowerShell scripts
4. `.env.linux.local` on shell scripts

Use `.env` and `.env.local` for shared secrets and strategy settings. Use the OS-specific overlay files only for platform details such as Python paths and proxy defaults.

All bundled start scripts resolve the project root from their own location, so they should keep working after the repository is moved to another Windows folder or copied to Linux. Avoid committing machine-local absolute paths into `.env` or `.env.local`.

Recommended shared paths:

```env
SOLANA_KEYPAIR_PATH=secrets/burner-live.json
LIVE_LOCAL_SIGNER_KEYPAIR_PATH=secrets/burner-live.json
GMGN_SAFETY_URL=http://127.0.0.1:8898/safety
```

Windows overlay example:

```env
LIGHTLD_DEFAULT_PROXY=http://127.0.0.1:7897
GMGN_PYTHON_BIN=C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe
```

Linux overlay example:

```env
GMGN_PYTHON_BIN=/usr/bin/python3
LIGHTLD_DEFAULT_PROXY=http://127.0.0.1:7897
```

Start GMGN safety before live trading when Node child processes are restricted:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-gmgn-safety.ps1
```

```bash
./start-gmgn-safety.sh
```

Common entrypoints:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-mainnet-execution.ps1
powershell -ExecutionPolicy Bypass -File .\start-mainnet-live.ps1
powershell -ExecutionPolicy Bypass -File .\start-candidate-worker.ps1
powershell -ExecutionPolicy Bypass -File .\start-daemon.ps1
powershell -ExecutionPolicy Bypass -File .\start-dashboard.ps1
```

```bash
./start-mainnet-execution.sh
./start-mainnet-live.sh
./start-dashboard.sh
```

Single-instance deployment:

Every bundled start script stops the matching old Lightld role before starting a new one. `start-mainnet-live` stops all live roles first: signer, execution, GMGN safety, candidate worker, daemon, and dashboard.

Runtime logs:

The start scripts append process output under `logs/`:

```text
logs/signer.log
logs/solana-execution.log
logs/gmgn-safety.log
logs/candidate-worker.log
logs/daemon.log
logs/dashboard.log
```

Manual cleanup is also available:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-lightld.ps1 -Role all
```

```bash
bash ./scripts/stop-lightld.sh all
```

Linux systemd deployment:

Use separate systemd services in production instead of wrapping every role in one shell. The templates live under `deploy/systemd/` and assume the repository is installed at `/opt/lightld`.

```bash
sudo cp deploy/systemd/lightld-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lightld-gmgn lightld-signer lightld-execution lightld-candidate-worker lightld-daemon lightld-dashboard
```

Useful checks:

```bash
systemctl status lightld-execution
journalctl -u lightld-execution -f
tail -f /opt/lightld/logs/solana-execution.log
```
