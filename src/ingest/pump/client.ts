import { fetchJson, type FetchImpl } from '../shared/http-client.ts';
import { SOURCE_ENDPOINTS, withSourceMetadata } from '../shared/source-metadata.ts';

type FetchPumpTradesOptions = {
  fetchImpl?: FetchImpl;
};

export async function fetchPumpTrades(options: FetchPumpTradesOptions = {}) {
  const rows = await fetchJson<Record<string, unknown>[]>(
    SOURCE_ENDPOINTS.pumpTrades,
    options
  );

  return rows.map((row) => withSourceMetadata('pump', row));
}
