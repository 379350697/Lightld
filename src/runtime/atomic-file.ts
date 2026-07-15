import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ZodType } from 'zod';

export async function writeJsonAtomically(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });

  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
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
