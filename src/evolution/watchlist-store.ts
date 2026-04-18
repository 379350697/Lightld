import { readFile } from 'node:fs/promises';

import { appendJsonLine, readJsonLines } from '../journals/jsonl-writer.ts';
import { writeJsonAtomically } from '../runtime/atomic-file.ts';
import {
  TrackedWatchTokenRecordArraySchema,
  WatchlistSnapshotRecordSchema,
  type TrackedWatchTokenRecord,
  type WatchlistSnapshotRecord
} from './types.ts';

type WatchlistStoreOptions = {
  trackedTokensPath: string;
  snapshotsPath: string;
};

export class WatchlistStore {
  private readonly trackedTokensPath: string;
  private readonly snapshotsPath: string;

  constructor(options: WatchlistStoreOptions) {
    this.trackedTokensPath = options.trackedTokensPath;
    this.snapshotsPath = options.snapshotsPath;
  }

  async writeTrackedTokens(tokens: TrackedWatchTokenRecord[]): Promise<void> {
    await writeJsonAtomically(
      this.trackedTokensPath,
      TrackedWatchTokenRecordArraySchema.parse(tokens)
    );
  }

  async readTrackedTokens(): Promise<TrackedWatchTokenRecord[]> {
    try {
      const raw = await readFile(this.trackedTokensPath, 'utf8');
      return TrackedWatchTokenRecordArraySchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  async appendSnapshot(snapshot: WatchlistSnapshotRecord): Promise<void> {
    await appendJsonLine(this.snapshotsPath, WatchlistSnapshotRecordSchema.parse(snapshot));
  }

  async readSnapshots(): Promise<WatchlistSnapshotRecord[]> {
    const rows = await readJsonLines<WatchlistSnapshotRecord>(this.snapshotsPath);
    return rows.map((row) => WatchlistSnapshotRecordSchema.parse(row));
  }
}
