import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteCandidatePool } from '../../../src/candidate-pool/sqlite-candidate-pool.ts';

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('compact:candidate-db', () => {
  it('blocks project writers while the maintenance lock is held', async () => {
    const root = join(process.cwd(), `.tmp-candidate-lock-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const databasePath = join(root, 'lightld-candidate-pool.sqlite');
    const pool = new SqliteCandidatePool({ path: databasePath });
    await pool.open();
    await writeFile(`${databasePath}.maintenance.lock`, 'test\n', 'utf8');
    await expect(pool.writeWorkerStatus({
      strategyId: 'new-token-v1', status: 'running', observedAt: new Date().toISOString(), expiresAt: new Date().toISOString()
    })).rejects.toThrow('maintenance');
    await rm(`${databasePath}.maintenance.lock`, { force: true });
    await pool.close();
  });

  it('backs up, prunes, checks and atomically replaces a stopped candidate database', async () => {
    const root = join(process.cwd(), `.tmp-candidate-compact-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const databasePath = join(root, 'lightld-candidate-pool.sqlite');
    const pool = new SqliteCandidatePool({ path: databasePath });
    await pool.open();
    await pool.recordPoolFeeYieldSamples({
      strategyId: 'new-token-v1',
      observedAt: new Date('2026-01-01T00:00:00.000Z'),
      rows: [{
        address: 'pool-old',
        baseMint: 'mint-old',
        baseSymbol: 'OLD',
        liquidityUsd: 20_000,
        pool_config: { dynamic_fee_pct: 1 },
        fees: { '30m': 10, '1h': 20, '2h': 40, '4h': 80, '12h': 240, '24h': 480 },
        protocol_fees: { '30m': 0, '1h': 0, '2h': 0, '4h': 0, '12h': 0, '24h': 0 },
        volume: { '1h': 10_000 }
      }]
    });
    await pool.close();

    const result = await execute(process.execPath, [
      '--experimental-strip-types',
      'src/cli/compact-candidate-db-main.ts',
      '--state-root-dir', root,
      '--retention-hours', '1'
    ], { cwd: process.cwd() });
    const output = JSON.parse(result.stdout);
    expect(output.quickCheck).toBe('ok');
    expect(output.rows.pool_fee_yield_samples).toBe(0);
    expect(existsSync(output.backupPath)).toBe(true);
    expect(existsSync(databasePath)).toBe(true);
  });
});
