import { fetchJson, type FetchImpl } from '../shared/http-client.ts';
import { SOURCE_ENDPOINTS, withSourceMetadata } from '../shared/source-metadata.ts';
import { buildMeteoraOhlcvUrl, buildMeteoraPoolsUrl } from './params.ts';

const METEORA_POOL_FETCH_ATTEMPTS = 2;

function isRetryableMeteoraPoolsError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return (
    error.message.includes('fetch failed') ||
    error.message.includes('timed out') ||
    error.message.includes('429') ||
    /\b5\d\d\b/.test(error.message)
  );
}

type FetchMeteoraPoolsOptions = {
  page?: number;
  pageSize?: number;
  query?: string;
  sortBy?: string;
  filterBy?: string;
  fetchImpl?: FetchImpl;
};

export async function fetchMeteoraPools(options: FetchMeteoraPoolsOptions = {}) {
  const url = buildMeteoraPoolsUrl(SOURCE_ENDPOINTS.meteoraPools, options);
  let response: { data: Record<string, unknown>[] } | Record<string, unknown>[];
  let lastError: unknown;

  for (let attempt = 1; attempt <= METEORA_POOL_FETCH_ATTEMPTS; attempt += 1) {
    try {
      response = await fetchJson<{ data: Record<string, unknown>[] }>(
        url,
        { fetchImpl: options.fetchImpl }
      );
      const rows = Array.isArray(response) ? response : (response?.data ?? []);

      return rows.map((row) => withSourceMetadata('meteora', row));
    } catch (error) {
      lastError = error;

      if (attempt >= METEORA_POOL_FETCH_ATTEMPTS || !isRetryableMeteoraPoolsError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[MeteoraIngest] Pools fetch attempt ${attempt}/${METEORA_POOL_FETCH_ATTEMPTS} failed: ${message}. Retrying.`
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type FetchMeteoraOhlcvOptions = {
  timeframe?: '5m' | '30m' | '1h' | '2h' | '4h' | '12h' | '24h';
  startTime?: number;
  endTime?: number;
  fetchImpl?: FetchImpl;
};

export async function fetchMeteoraOhlcv(
  address: string,
  options: FetchMeteoraOhlcvOptions = {}
) {
  const url = buildMeteoraOhlcvUrl(SOURCE_ENDPOINTS.meteoraPools, address, options);

  return fetchJson<{
    data: Array<Record<string, number | string>>;
    timeframe: string;
    start_time: number;
    end_time: number;
  }>(url, { fetchImpl: options.fetchImpl });
}
