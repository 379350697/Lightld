import { existsSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const TABLES = [
  'candidate_pool',
  'candidate_source_observations',
  'candidate_pool_worker_status',
  'pool_fee_yield_samples',
  'pool_fee_yield_profiles',
  'pool_fee_yield_retirements'
] as const;

async function main() {
  const argv = process.argv.slice(2);
  const argument = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const stateRoot = resolve(argument('--state-root-dir') ?? process.env.LIVE_STATE_DIR ?? 'state');
  const databasePath = resolve(argument('--db-path') ?? join(stateRoot, 'lightld-candidate-pool.sqlite'));
  if (databasePath !== stateRoot && !databasePath.startsWith(`${stateRoot}\\`) && !databasePath.startsWith(`${stateRoot}/`)) {
    throw new Error('Candidate database must be inside StateRoot');
  }
  if (!existsSync(databasePath)) throw new Error(`Candidate database does not exist: ${databasePath}`);
  const retentionHours = Number(argument('--retention-hours') ?? 48);
  if (!Number.isFinite(retentionHours) || retentionHours <= 0) throw new Error('retention-hours must be positive');
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const base = join(dirname(databasePath), `${basename(databasePath)}.${stamp}`);
  const backupPath = `${base}.backup.sqlite`;
  const workingPath = `${base}.working.sqlite`;
  const compactPath = `${base}.compact.sqlite`;
  const beforeBytes = (await stat(databasePath)).size;
  let originalCounts: Record<string, number>;
  let originalLatest: string | null;

  try {
    const source = new DatabaseSync(databasePath);
    try {
      source.exec('PRAGMA busy_timeout=1000; PRAGMA wal_checkpoint(TRUNCATE);');
      quickCheck(source);
      originalCounts = counts(source);
      originalLatest = latest(source);
      await backup(source, backupPath);
      await backup(source, workingPath);
      source.exec('BEGIN EXCLUSIVE; COMMIT;');
    } catch (error) {
      try { source.exec('ROLLBACK'); } catch {}
      throw new Error(`Stop candidate worker and daemon before compaction: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      source.close();
    }

    const working = new DatabaseSync(workingPath);
    let retainedCounts: Record<string, number>;
    let retainedLatest: string | null;
    try {
      const cutoff = new Date(Date.now() - retentionHours * 60 * 60_000).toISOString();
      working.exec('BEGIN IMMEDIATE');
      working.prepare('DELETE FROM pool_fee_yield_samples WHERE observed_at < ?').run(cutoff);
      working.prepare('DELETE FROM pool_fee_yield_retirements WHERE expires_at < ?').run(new Date().toISOString());
      working.exec('COMMIT');
      quickCheck(working);
      retainedCounts = counts(working);
      retainedLatest = latest(working);
      working.exec(`VACUUM INTO '${compactPath.replaceAll("'", "''")}'`);
    } finally {
      working.close();
    }

    const compact = new DatabaseSync(compactPath, { readOnly: true });
    try {
      quickCheck(compact);
      if (JSON.stringify(counts(compact)) !== JSON.stringify(retainedCounts!) || latest(compact) !== retainedLatest!) {
        throw new Error('Compacted candidate database verification failed');
      }
    } finally {
      compact.close();
    }

    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if (JSON.stringify(counts(unchanged)) !== JSON.stringify(originalCounts!) || latest(unchanged) !== originalLatest!) {
        throw new Error('Candidate database changed during compaction; original was not replaced');
      }
    } finally {
      unchanged.close();
    }

    await rename(compactPath, databasePath);
    const afterBytes = (await stat(databasePath)).size;
    process.stdout.write(`${JSON.stringify({
      databasePath,
      backupPath,
      retentionHours,
      beforeBytes,
      afterBytes,
      reclaimedBytes: beforeBytes - afterBytes,
      rows: retainedCounts!,
      latestSampleAt: retainedLatest!,
      quickCheck: 'ok'
    }, null, 2)}\n`);
  } finally {
    await rm(workingPath, { force: true });
    await rm(compactPath, { force: true });
  }
}

function counts(database: DatabaseSync) {
  return Object.fromEntries(TABLES.map((table) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint };
    return [table, Number(row.count)];
  }));
}

function latest(database: DatabaseSync) {
  return (database.prepare('SELECT MAX(observed_at) AS latest FROM pool_fee_yield_samples').get() as { latest: string | null }).latest;
}

function quickCheck(database: DatabaseSync) {
  const result = database.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
  if (result?.quick_check !== 'ok') throw new Error(`SQLite quick_check failed: ${JSON.stringify(result)}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
