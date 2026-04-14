import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

export async function appendJsonLine(path: string, entry: object): Promise<void> {
  const compacted = compactLogValue(entry);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(compacted ?? {})}\n`, 'utf8');
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, 'utf8');

    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
