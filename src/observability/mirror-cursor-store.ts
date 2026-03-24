import { join } from 'node:path';

import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from '../runtime/atomic-file.ts';

const MirrorCursorSnapshotSchema = z.object({
  offsets: z.record(z.string(), z.number().int().nonnegative())
});

type MirrorCursorSnapshot = z.infer<typeof MirrorCursorSnapshotSchema>;

export class MirrorCursorStore {
  private readonly path: string;

  constructor(rootDir: string) {
    this.path = join(rootDir, 'mirror-cursor.json');
  }

  async read() {
    return (await readJsonIfExists(this.path, MirrorCursorSnapshotSchema)) ?? {
      offsets: {}
    };
  }

  async write(snapshot: MirrorCursorSnapshot) {
    await writeJsonAtomically(this.path, MirrorCursorSnapshotSchema.parse(snapshot));
  }
}
