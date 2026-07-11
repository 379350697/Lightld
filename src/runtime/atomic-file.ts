import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import type { ZodType } from 'zod';

export async function writeJsonAtomically(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });

  // A durable state transition must never expose a partially written JSON
  // document.  A unique temp name also avoids two independent writers in the
  // same process clobbering each other before the rename.
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
}

export async function readJsonIfExists<T>(
  path: string,
  schema: ZodType<T>
): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');

    return schema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function deleteFileIfExists(path: string) {
  await rm(path, { force: true });
}
