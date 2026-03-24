import { fetchJson, type FetchImpl } from '../shared/http-client.ts';
import { SOURCE_ENDPOINTS, withSourceMetadata } from '../shared/source-metadata.ts';
import { buildMeteoraOhlcvUrl, buildMeteoraPoolsUrl } from './params.ts';

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
  const rows = await fetchJson<Record<string, unknown>[]>(
    url,
    { fetchImpl: options.fetchImpl }
  );

  return rows.map((row) => withSourceMetadata('meteora', row));
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
