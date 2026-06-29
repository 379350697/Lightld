import { isAbsolute, resolve, win32 } from 'node:path';

export function resolveEnvPath(value: string | undefined, baseDir = process.cwd()) {
  if (!value) {
    return value;
  }

  if (isAbsolute(value) || win32.isAbsolute(value)) {
    return value;
  }

  return resolve(baseDir, value);
}
