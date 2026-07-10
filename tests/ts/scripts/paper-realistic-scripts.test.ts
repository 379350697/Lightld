import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('paper realistic startup scripts', () => {
  it('redirects each role to durable logs so hidden service failures are diagnosable', () => {
    const script = readFileSync(join(repoRoot, 'scripts', 'start-paper-realistic.ps1'), 'utf8');

    expect(script).toContain('$LogRoot');
    expect(script).toContain('-RedirectStandardOutput');
    expect(script).toContain('-RedirectStandardError');
    expect(script).toContain('paper-realistic-$role.out.log');
    expect(script).toContain('paper-realistic-$role.err.log');
  });

  it('restarts long-lived paper execution services instead of letting account-state die silently', () => {
    const script = readFileSync(join(repoRoot, 'scripts', 'run-paper-realistic-component.ps1'), 'utf8');

    expect(script).toContain('Invoke-PaperRoleLoop');
    expect(script).toContain('-CommandName "run:solana-execution"');
    expect(script).toContain('-RoleName "execution"');
    expect(script).toContain('$RoleName exited command=$CommandName');
  });
});
