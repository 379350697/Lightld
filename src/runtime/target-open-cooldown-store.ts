import { join } from 'node:path';

import {
  TargetOpenCooldownSnapshotSchema,
  type TargetOpenCooldownSnapshot
} from './state-types.ts';
import { deleteFileIfExists, readJsonIfExists, writeJsonAtomically } from './atomic-file.ts';

function buildCooldownKey(input: { poolAddress?: string; tokenMint?: string }) {
  return `${input.poolAddress ?? ''}::${input.tokenMint ?? ''}`;
}

export class TargetOpenCooldownStore {
  private readonly path: string;

  constructor(rootDir: string) {
    this.path = join(rootDir, 'target-open-cooldowns.json');
  }

  async readAll() {
    return (await readJsonIfExists(
      this.path,
      TargetOpenCooldownSnapshotSchema.array()
    )) ?? [];
  }

  async writeAll(rows: TargetOpenCooldownSnapshot[]) {
    await writeJsonAtomically(this.path, TargetOpenCooldownSnapshotSchema.array().parse(rows));
  }

  async readActive(input: { poolAddress?: string; tokenMint?: string; now?: string }) {
    const key = buildCooldownKey(input);
    const now = input.now ?? new Date().toISOString();
    const rows = await this.readAll();
    return rows.find((row) => buildCooldownKey(row) === key && row.cooldownUntil > now) ?? null;
  }

  async upsert(snapshot: TargetOpenCooldownSnapshot) {
    const rows = await this.readAll();
    const key = buildCooldownKey(snapshot);
    const nextRows = rows.filter((row) => buildCooldownKey(row) !== key);
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
