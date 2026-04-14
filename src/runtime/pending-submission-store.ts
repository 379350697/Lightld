import { join } from 'node:path';

import type { PendingSubmissionSnapshot } from './state-types.ts';
import { PendingSubmissionSnapshotSchema } from './state-types.ts';
import { deleteFileIfExists, readJsonIfExists, writeJsonAtomically } from './atomic-file.ts';

export class PendingSubmissionStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async write(snapshot: PendingSubmissionSnapshot) {
    await writeJsonAtomically(
      join(this.rootDir, 'pending-submission.json'),
      PendingSubmissionSnapshotSchema.parse(snapshot)
    );
  }

  async read(): Promise<PendingSubmissionSnapshot | null> {
    return readJsonIfExists(
      join(this.rootDir, 'pending-submission.json'),
      PendingSubmissionSnapshotSchema
    );
  }

  async clear() {
    await deleteFileIfExists(join(this.rootDir, 'pending-submission.json'));
  }
}
