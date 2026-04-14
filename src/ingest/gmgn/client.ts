import { fetchJson, type FetchImpl } from '../shared/http-client.ts';
import { SOURCE_ENDPOINTS, withSourceMetadata } from '../shared/source-metadata.ts';

type FetchGmgnTraderOptions = {
  fetchImpl?: FetchImpl;
};

export async function fetchGmgnTrader(wallet: string, options: FetchGmgnTraderOptions = {}) {
  const payload = await fetchJson<Record<string, unknown>>(
    `${SOURCE_ENDPOINTS.gmgnTraderBase}/${encodeURIComponent(wallet)}`,
    options
  );

  return withSourceMetadata('gmgn', payload);
}
