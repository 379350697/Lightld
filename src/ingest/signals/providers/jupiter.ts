import {
  fetchSignalJson,
  isRecord,
  readNumber,
  readString
} from '../provider-utils.ts';
import type {
  AuxiliarySignalCandidate,
  AuxiliarySignalProvider,
  AuxiliarySignalProviderOptions,
  AuxiliarySignalProviderResult
} from '../types.ts';

const DEFAULT_BASE_URL = 'https://api.jup.ag';
const DEFAULT_API_KEY_ENV = 'JUPITER_API_KEY';
const TRENDING_LIMIT = 100;

let cachedTrending: {
  baseUrl: string;
  apiKey: string;
  fetchedAt: number;
  rows: Record<string, unknown>[];
} | null = null;

export const jupiterSignalProvider: AuxiliarySignalProvider = {
  name: 'jupiter',
  fetchSignal
};

export function clearJupiterSignalProviderCacheForTests() {
  cachedTrending = null;
}

async function fetchSignal(
  candidate: AuxiliarySignalCandidate,
  options: AuxiliarySignalProviderOptions = {}
): Promise<AuxiliarySignalProviderResult> {
  const apiKey = options.apiKey ?? process.env[DEFAULT_API_KEY_ENV] ?? '';
  if (!apiKey) {
    return emptyResult('missing-api-key');
  }

  if (!candidate.mint) {
    return emptyResult('missing-mint');
  }

  try {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const headers = { 'x-api-key': apiKey };
    const [tokenRows, trendingRows] = await Promise.all([
      fetchSignalJson<unknown>(
        `${baseUrl}/tokens/v2/search?query=${encodeURIComponent(candidate.mint)}`,
        { fetchImpl: options.fetchImpl, headers }
      ),
      fetchTrendingRows(baseUrl, apiKey, options)
    ]);

    const token = Array.isArray(tokenRows)
      ? tokenRows.find((item) => isRecord(item) && readString(item, ['id']) === candidate.mint)
      : undefined;
    const organicScore = isRecord(token) ? readNumber(token, ['organicScore']) : 0;
    const trendingRank = resolveTrendingRank(trendingRows, candidate);

    return {
      provider: 'jupiter',
      status: 'available',
      signalScore: resolveJupiterScore({ organicScore, trendingRank }),
      jupiterOrganicScore: organicScore,
      jupiterTrendingRank: trendingRank
    };
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : String(error));
  }
}

async function fetchTrendingRows(
  baseUrl: string,
  apiKey: string,
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

  const rows = await fetchSignalJson<unknown>(
    `${baseUrl}/tokens/v2/toptrending/5m?limit=${TRENDING_LIMIT}`,
    {
      fetchImpl: options.fetchImpl,
      headers: { 'x-api-key': apiKey }
    }
  );
  const parsedRows = Array.isArray(rows)
    ? rows.filter(isRecord)
    : [];
  cachedTrending = {
    baseUrl,
    apiKey,
    fetchedAt: now,
    rows: parsedRows
  };

  return parsedRows;
}

function resolveTrendingRank(
  rows: Record<string, unknown>[],
  candidate: AuxiliarySignalCandidate
) {
  const index = rows.findIndex((row) =>
    readString(row, ['id', 'address', 'mint']) === candidate.mint ||
    readString(row, ['symbol']).toUpperCase() === candidate.symbol.toUpperCase()
  );

  return index >= 0 ? index + 1 : 0;
}

function resolveJupiterScore(input: { organicScore: number; trendingRank: number }) {
  const organicScore = Math.min(15, Math.max(0, input.organicScore) / 8);
  const trendingScore = input.trendingRank > 0
    ? Math.max(0, 20 - input.trendingRank) / 2
    : 0;

  return organicScore + trendingScore;
}

function emptyResult(error: string): AuxiliarySignalProviderResult {
  return {
    provider: 'jupiter',
    status: 'unavailable',
    signalScore: 0,
    jupiterOrganicScore: 0,
    jupiterTrendingRank: 0,
    error
  };
}
