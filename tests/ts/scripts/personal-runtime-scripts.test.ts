import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('personal paper/live scripts', () => {
  it('keeps paper mode and StateRoot isolated', async () => {
    const script = await readFile('scripts/run-paper-realistic-component.ps1', 'utf8');
    expect(script).toContain('$env:LIGHTLD_RUN_MODE = "mechanical-soak"');
    expect(script).toContain('$env:LIGHTLD_EXECUTION_MODE = "mechanical-soak"');
    expect(script).toContain('$env:SOLANA_EXECUTION_DRY_RUN = "true"');
    expect(script).toContain('(Join-Path $StateRoot "lightld-candidate-pool.sqlite")');
    expect(script).not.toContain('"state/lightld-candidate-pool.sqlite"');
  });

  it('provides a full Linux paper launcher with the same isolation and research worker', async () => {
    const script = await readFile('scripts/start-paper-realistic.sh', 'utf8');
    expect(script).toContain('export LIGHTLD_RUN_MODE=mechanical-soak');
    expect(script).toContain('export LIGHTLD_EXECUTION_MODE=mechanical-soak');
    expect(script).toContain('export SOLANA_EXECUTION_DRY_RUN=true');
    expect(script).toContain('run:research-worker');
    expect(script).toContain('--state-root-dir "$STATE_ROOT"');
  });

  it('requires explicit human confirmation for live on Windows and Linux', async () => {
    const [powershell, shell] = await Promise.all([
      readFile('start-mainnet-live.ps1', 'utf8'),
      readFile('start-mainnet-live.sh', 'utf8')
    ]);
    expect(powershell).toContain('I_UNDERSTAND_MAINNET');
    expect(powershell).toContain('$env:LIGHTLD_RUN_MODE = "live"');
    expect(shell).toContain('I_UNDERSTAND_MAINNET');
    expect(shell).toContain('export LIGHTLD_RUN_MODE=live');
  });

  it('keeps lightweight research worker launchers on both platforms', async () => {
    const [powershell, shell] = await Promise.all([
      readFile('start-research-worker.ps1', 'utf8'),
      readFile('start-research-worker.sh', 'utf8')
    ]);
    expect(powershell).toContain('run:research-worker');
    expect(shell).toContain('run:research-worker');
  });
});
