import type { FetchImpl } from '../shared/http-client.ts';

type FetchSignalJsonOptions = {
  fetchImpl?: FetchImpl;
  headers?: Record<string, string>;
};

export async function fetchSignalJson<T>(
  url: string,
  options: FetchSignalJsonOptions = {}
): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: options.headers
  });

  if (!response.ok) {
    const detail = [response.status, response.statusText]
      .filter((value) => value !== undefined && value !== '')
      .join(' ')
      .trim();

    throw new Error(detail ? `Request failed for ${url}: ${detail}` : `Request failed for ${url}`);
  }

  return response.json() as Promise<T>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readNumber(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}

export function readString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return '';
}
