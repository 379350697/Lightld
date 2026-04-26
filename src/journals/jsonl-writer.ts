import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

function compactLogValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value === '' ? undefined : value;
  }

  if (Array.isArray(value)) {
    const compacted = value
      .map((entry) => compactLogValue(entry))
      .filter((entry) => entry !== undefined);

    return compacted.length > 0 ? compacted : undefined;
  }

  if (typeof value === 'object') {
    const compactedEntries = Object.entries(value)
      .map(([key, entry]) => [key, compactLogValue(entry)] as const)
      .filter(([, entry]) => entry !== undefined);

    return compactedEntries.length > 0 ? Object.fromEntries(compactedEntries) : undefined;
  }

  return value;
}

export type JsonlFileOptions = {
  rotateDaily?: boolean;
  retentionDays?: number;
  now?: Date;
};

function startOfUtcDay(date: Date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function formatUtcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRotatedJsonlPattern(path: string) {
  const extension = extname(path);
  const fileName = basename(path, extension);

  return new RegExp(`^${escapeRegExp(fileName)}-(\\d{4}-\\d{2}-\\d{2})${escapeRegExp(extension)}$`);
}

export function resolveActiveJsonlPath(path: string, now = new Date()) {
  const extension = extname(path);
  const fileName = basename(path, extension);

  return join(dirname(path), `${fileName}-${formatUtcDate(now)}${extension}`);
}

export async function listRotatedJsonlPaths(path: string): Promise<string[]> {
  const directory = dirname(path);
  const pattern = buildRotatedJsonlPattern(path);

  try {
    const entries = await readdir(directory, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export async function cleanupRotatedJsonlFiles(
  path: string,
  options: { retentionDays: number; now?: Date }
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoffDay = startOfUtcDay(now) - options.retentionDays * 24 * 60 * 60 * 1000;
  const pattern = buildRotatedJsonlPattern(path);
  let deleted = 0;

  try {
    const entries = await readdir(dirname(path), { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const match = pattern.exec(entry.name);
      if (!match) {
        continue;
      }

      const fileDay = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (Number.isNaN(fileDay) || fileDay >= cutoffDay) {
        continue;
      }

      await rm(join(dirname(path), entry.name), { force: true });
      deleted += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }

    throw error;
  }

  return deleted;
}

function resolveAppendPath(path: string, options?: JsonlFileOptions) {
  if (!options?.rotateDaily) {
    return path;
  }

  return resolveActiveJsonlPath(path, options.now ?? new Date());
}

export async function appendJsonLine(path: string, entry: object, options?: JsonlFileOptions): Promise<void> {
  const compacted = compactLogValue(entry);
  const targetPath = resolveAppendPath(path, options);

  if (options?.rotateDaily && typeof options.retentionDays === 'number' && options.retentionDays > 0) {
    await cleanupRotatedJsonlFiles(path, {
      retentionDays: options.retentionDays,
      now: options.now ?? new Date()
    });
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await appendFile(targetPath, `${JSON.stringify(compacted ?? {})}\n`, 'utf8');
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, 'utf8');

    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export async function readRotatedJsonLines<T>(path: string): Promise<T[]> {
  const rotatedPaths = await listRotatedJsonlPaths(path);

  if (rotatedPaths.length === 0) {
    return readJsonLines<T>(path);
  }

  const nested = await Promise.all(rotatedPaths.map((rotatedPath) => readJsonLines<T>(rotatedPath)));
  return nested.flat();
}

export async function readRotatedJsonTail<T>(path: string, maxLines: number): Promise<T[]> {
  const allLines = await readRotatedJsonLines<T>(path);
  return allLines.slice(-maxLines);
}
