import {
  fetchSignalJson,
  isRecord,
  readString
} from '../provider-utils.ts';
import type {
  AuxiliarySignalCandidate,
  AuxiliarySignalProvider,
  AuxiliarySignalProviderOptions,
  AuxiliarySignalProviderResult
} from '../types.ts';

const DEFAULT_BASE_URL = 'https://api.coingecko.com/api/v3';
const DEFAULT_API_KEY_ENV = 'COINGECKO_API_KEY';

let cachedTrending: {
  baseUrl: string;
  apiKey: string;
  fetchedAt: number;
  rows: Record<string, unknown>[];
} | null = null;

export const coingeckoSignalProvider: AuxiliarySignalProvider = {
  name: 'coingecko',
  fetchSignal
};

export function clearCoingeckoSignalProviderCacheForTests() {
  cachedTrending = null;
}

async function fetchSignal(
  candidate: AuxiliarySignalCandidate,
  options: AuxiliarySignalProviderOptions = {}
): Promise<AuxiliarySignalProviderResult> {
  if (!candidate.symbol) {
    return emptyResult('missing-symbol');
  }

  try {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const apiKey = options.apiKey ?? process.env[DEFAULT_API_KEY_ENV] ?? '';
    const headers = apiKey ? { 'x-cg-demo-api-key': apiKey } : undefined;
    const rows = await fetchTrendingRows(baseUrl, apiKey, headers, options);
    const rank = resolveTrendingRank(rows, candidate);

    return {
      provider: 'coingecko',
      status: 'available',
      signalScore: rank > 0 ? Math.max(0, 16 - rank) : 0,
      coingeckoTrendingRank: rank
    };
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : String(error));
  }
}

async function fetchTrendingRows(
  baseUrl: string,
  apiKey: string,
  headers: Record<string, string> | undefined,
  options: AuxiliarySignalProviderOptions
) {
  const now = Date.now();
  if (
    cachedTrending &&
    cachedTrending.baseUrl === baseUrl &&
    cachedTrending.apiKey === apiKey &&
    now - cachedTrending.fetchedAt < 60_000
  ) {
    return cachedTrending.rows;
  }

  const payload = await fetchSignalJson<unknown>(
    `${baseUrl}/search/trending`,
    { fetchImpl: options.fetchImpl, headers }
  );
  const rows = isRecord(payload) && Array.isArray(payload.coins)
    ? payload.coins
      .map((item) => isRecord(item) && isRecord(item.item) ? item.item : null)
      .filter(isRecord)
    : [];

  cachedTrending = {
    baseUrl,
    apiKey,
    fetchedAt: now,
    rows
  };

  return rows;
}

function resolveTrendingRank(
  rows: Record<string, unknown>[],
  candidate: AuxiliarySignalCandidate
) {
  const symbol = candidate.symbol.toUpperCase();
  const index = rows.findIndex((row) =>
    readString(row, ['symbol']).toUpperCase() === symbol ||
    readString(row, ['name']).toUpperCase() === symbol
  );

  return index >= 0 ? index + 1 : 0;
}

function emptyResult(error: string): AuxiliarySignalProviderResult {
  return {
    provider: 'coingecko',
    status: 'unavailable',
    signalScore: 0,
    coingeckoTrendingRank: 0,
    error
  };
}
