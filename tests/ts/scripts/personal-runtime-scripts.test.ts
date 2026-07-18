import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('personal paper/live scripts', () => {
  it('keeps paper mode and StateRoot isolated', async () => {
    const [script, launcher] = await Promise.all([
      readFile('scripts/run-paper-realistic-component.ps1', 'utf8'),
      readFile('scripts/start-paper-realistic.ps1', 'utf8')
    ]);
    expect(script).toContain('$env:LIGHTLD_RUN_MODE = "mechanical-soak"');
    expect(script).toContain('$env:LIGHTLD_EXECUTION_MODE = "mechanical-soak"');
    expect(script).toContain('$env:SOLANA_EXECUTION_DRY_RUN = "true"');
    expect(script).toContain('(Join-Path $StateRoot "lightld-candidate-pool.sqlite")');
    expect(script).toContain('Paper signer health check failed');
    expect(script).not.toContain('"state/lightld-candidate-pool.sqlite"');
    expect(script).not.toContain('LIVE_DISABLE_DYNAMIC_POSITION_SIZING');
    expect(script).not.toContain('LIVE_IGNORE_POSITION_SOL_LIMIT');
    expect(script).not.toContain('LIVE_IGNORE_SPENDING_LIMITS');
    expect(script).not.toContain('1000000');
    expect(script).toContain('LIVE_LOCAL_SIGNER_PORT = "8787"');
    expect(script).toContain('GMGN_SAFETY_URL');
    expect(script).toContain('start-gmgn-safety.ps1');
    expect(script).toContain('Paper GMGN safety health check failed');
    expect(script).toContain('$health.dryRun -eq $true');
    expect(script).toContain('JITO_TIP_LAMPORTS = "25000"');
    expect(script).toContain('SOLANA_DEFAULT_SLIPPAGE_BPS = "100"');
    expect(script).toContain('[ValidateSet("new-token-v1", "large-pool-v1")]');
    expect(script).toContain('--strategy $Strategy');
    expect(launcher).toContain('[int]$MaxActivePositions = 5');
    expect(launcher).toContain('[string]$Strategy = "new-token-v1"');
    expect(launcher).toContain('"-Strategy"');
    expect(launcher).toContain('Write-LightldProcessRecord');
    expect(launcher).toContain('-StateRoot $StateRoot -Role all');
    expect(script).toContain('Enter-LightldRoleLock');
    expect(script).toContain('LIGHTLD_DAEMON_RESTART_DELAY_MS');
    expect(script).toContain('LIGHTLD_DAEMON_WATCHDOG_STALE_AFTER_MS');
    expect(script).toContain('component-logs');
    expect(script).toContain('Start-Process -FilePath "npm.cmd"');
    expect(script).toContain('taskkill.exe /PID $daemonProcess.Id /T /F');
    expect(launcher).not.toContain('RequestedPositionSol');
    expect(launcher).not.toContain('100000');
  });

  it('provides a full Linux paper launcher with the same isolation and research worker', async () => {
    const script = await readFile('scripts/start-paper-realistic.sh', 'utf8');
    expect(script).toContain('export LIGHTLD_RUN_MODE=mechanical-soak');
    expect(script).toContain('export LIGHTLD_EXECUTION_MODE=mechanical-soak');
    expect(script).toContain('export SOLANA_EXECUTION_DRY_RUN=true');
    expect(script).toContain('start_component research');
    expect(script).toContain('Paper signer health check failed');
    expect(script).toContain('GMGN_SAFETY_URL');
    expect(script).not.toContain('LIVE_DISABLE_DYNAMIC_POSITION_SIZING');
    expect(script).not.toContain('LIVE_IGNORE_POSITION_SOL_LIMIT');
    expect(script).not.toContain('LIVE_IGNORE_SPENDING_LIMITS');
    expect(script).not.toContain('1000000');
    expect(script).toContain('scripts/stop-lightld.sh" --state-root "$STATE_ROOT" all');
    expect(script).toContain('dryRun');
    expect(script).toContain('LIVE_LOCAL_SIGNER_PORT:-8787');
    expect(script).toContain('LIGHTLD_PAPER_STRATEGY:-new-token-v1');
    expect(script).toContain('new-token-v1|large-pool-v1');
    expect(script).toContain('setsid bash "$ROOT/scripts/run-paper-realistic-component.sh"');
    expect(script).toContain('lightld_write_process_record');
    expect(script).toContain('stop-lightld.sh" --state-root "$STATE_ROOT" all');

    const component = await readFile('scripts/run-paper-realistic-component.sh', 'utf8');
    expect(component).toContain('export LIGHTLD_RUN_MODE=mechanical-soak');
    expect(component).toContain('export LIGHTLD_EXECUTION_MODE=mechanical-soak');
    expect(component).toContain('JITO_TIP_LAMPORTS="${JITO_TIP_LAMPORTS:-25000}"');
    expect(component).toContain('SOLANA_DEFAULT_SLIPPAGE_BPS="${SOLANA_DEFAULT_SLIPPAGE_BPS:-100}"');
    expect(component).toContain('flock -n 8');
    expect(component).toContain('run:signer');
    expect(component).toContain('gmgn-token-safety-server.py');
    expect(component).toContain('run:solana-execution');
    expect(component).toContain('run:research-worker');
    expect(component).toContain('run:daemon');
    expect(component).toContain('daemon) restart_worker daemon npm run run:daemon');
    expect(component).toContain('--strategy "$STRATEGY"');
    expect(component).toContain('--state-root-dir "$STATE_ROOT"');
  });

  it('requires explicit human confirmation for live on Windows and Linux', async () => {
    const [powershell, shell] = await Promise.all([
      readFile('start-mainnet-live.ps1', 'utf8'),
      readFile('start-mainnet-live.sh', 'utf8')
    ]);
    expect(powershell).toContain('I_UNDERSTAND_MAINNET');
    expect(powershell).toContain('$env:LIGHTLD_RUN_MODE = "live"');
    expect(powershell).toContain('Write-LightldProcessRecord');
    expect(powershell).toContain('Wait-HttpHealth "http://127.0.0.1:$SignerPort/health"');
    expect(powershell).toContain('--state-root-dir `$env:LIVE_STATE_DIR');
    expect(shell).toContain('I_UNDERSTAND_MAINNET');
    expect(shell).toContain('export LIGHTLD_RUN_MODE=live');
    expect(shell).toContain('lightld_write_process_record');
    expect(shell).toContain('wait_for_health "Signer"');
    expect(shell).toContain('stop-lightld.sh" --state-root "$STATE_ROOT" all');

    const liveComponent = await readFile('scripts/run-mainnet-live-component.sh', 'utf8');
    expect(liveComponent).toContain('JITO_TIP_LAMPORTS="${JITO_TIP_LAMPORTS:-25000}"');
    expect(liveComponent).toContain('SOLANA_DEFAULT_SLIPPAGE_BPS="${SOLANA_DEFAULT_SLIPPAGE_BPS:-100}"');
  });

  it('keeps lightweight research worker launchers on both platforms', async () => {
    const [powershell, shell] = await Promise.all([
      readFile('start-research-worker.ps1', 'utf8'),
      readFile('start-research-worker.sh', 'utf8')
    ]);
    expect(powershell).toContain('"-Role", "research"');
    expect(shell).toContain('run-paper-realistic-component.sh');
    expect(shell).toContain('research "$ROOT" "$STATE_ROOT"');
  });

  it('stops only PID-identity-verified process trees and never authorizes a kill by port alone', async () => {
    const [powershell, shell, records] = await Promise.all([
      readFile('scripts/stop-lightld.ps1', 'utf8'),
      readFile('scripts/stop-lightld.sh', 'utf8'),
      readFile('scripts/lightld-process-records.ps1', 'utf8')
    ]);
    expect(records).toContain('processStartedAtUtcTicks');
    expect(records).toContain('[System.IO.FileShare]::None');
    expect(records).toContain('.lightld-run-mode');
    expect(records).toContain("belongs to '$ExistingMode', not '$Mode'");
    expect(powershell).toContain('taskkill.exe /PID $ProcessId /T /F');
    expect(powershell).toContain('$ActualStartedAtUtcTicks -ne $ExpectedStartedAtUtcTicks');
    expect(powershell).toContain('Ports alone never authorize');
    expect(shell).toContain('actual_ticks" != "$expected_ticks');
    expect(shell).toContain('kill -- "-$pid"');
    expect(shell).toContain('No port-only kill');
  });
});
