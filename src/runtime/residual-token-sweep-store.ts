import { join } from 'node:path';

import { z } from 'zod';

import { deleteFileIfExists, readJsonIfExists, writeJsonAtomically } from './atomic-file.ts';

export const ResidualTokenSweepSnapshotSchema = z.object({
  mint: z.string(),
  lastAttemptAt: z.string(),
  cooldownUntil: z.string(),
  updatedAt: z.string()
});

export type ResidualTokenSweepSnapshot = z.infer<typeof ResidualTokenSweepSnapshotSchema>;

function buildKey(mint: string) {
  return mint;
}

export class ResidualTokenSweepStore {
  private readonly path: string;

  constructor(rootDir: string) {
    this.path = join(rootDir, 'residual-token-sweeps.json');
  }

  async readAll() {
    return (await readJsonIfExists(this.path, ResidualTokenSweepSnapshotSchema.array())) ?? [];
  }

  async writeAll(rows: ResidualTokenSweepSnapshot[]) {
    await writeJsonAtomically(this.path, ResidualTokenSweepSnapshotSchema.array().parse(rows));
  }

  async readActive(mint: string, now = new Date().toISOString()) {
    const rows = await this.readAll();
    return rows.find((row) => buildKey(row.mint) === mint && row.cooldownUntil > now) ?? null;
  }

  async upsert(snapshot: ResidualTokenSweepSnapshot) {
    const rows = await this.readAll();
    const nextRows = rows.filter((row) => buildKey(row.mint) !== buildKey(snapshot.mint));
    nextRows.push(snapshot);
    await this.writeAll(nextRows);
  }

  async pruneExpired(now = new Date().toISOString()) {
    const rows = await this.readAll();
    const nextRows = rows.filter((row) => row.cooldownUntil > now);

    if (nextRows.length === rows.length) {
      return;
    }

    if (nextRows.length === 0) {
      await deleteFileIfExists(this.path);
      return;
    }

    await this.writeAll(nextRows);
  }
}
