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

const DEFAULT_BASE_URL = 'https://public-api.birdeye.so';
const DEFAULT_API_KEY_ENV = 'BIRDEYE_API_KEY';
const TRENDING_LIMIT = 20;

export const birdeyeSignalProvider: AuxiliarySignalProvider = {
  name: 'birdeye',
  fetchSignal
};

async function fetchSignal(
  candidate: AuxiliarySignalCandidate,
  options: AuxiliarySignalProviderOptions = {}
): Promise<AuxiliarySignalProviderResult> {
  const apiKey = options.apiKey ?? process.env[DEFAULT_API_KEY_ENV] ?? '';
  if (!apiKey) {
    return emptyResult('missing-api-key');
  }

  try {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const payload = await fetchSignalJson<unknown>(
      `${baseUrl}/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=${TRENDING_LIMIT}`,
      {
        fetchImpl: options.fetchImpl,
        headers: {
          'X-API-KEY': apiKey,
          'x-chain': 'solana',
          accept: 'application/json'
        }
      }
    );
    const rows = isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.tokens)
      ? payload.data.tokens.filter(isRecord)
      : [];
    const index = rows.findIndex((row) =>
      readString(row, ['address']) === candidate.mint ||
      readString(row, ['symbol']).toUpperCase() === candidate.symbol.toUpperCase()
    );
    const rank = index >= 0 ? index + 1 : 0;

    return {
      provider: 'birdeye',
      status: 'available',
      signalScore: rank > 0 ? Math.max(0, 21 - rank) / 2 : 0,
      birdeyeTrendingRank: rank
    };
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : String(error));
  }
}

function emptyResult(error: string): AuxiliarySignalProviderResult {
  return {
    provider: 'birdeye',
    status: 'unavailable',
    signalScore: 0,
    birdeyeTrendingRank: 0,
    error
  };
}
