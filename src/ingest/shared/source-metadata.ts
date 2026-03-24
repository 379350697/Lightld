export const SOURCE_ENDPOINTS = {
  meteoraPools: process.env.METEORA_POOLS_URL ?? 'https://dlmm.datapi.meteora.ag/pools',
  pumpTrades: process.env.PUMP_TRADES_URL ?? 'https://example.invalid/pump/trades',
  gmgnTraderBase: process.env.GMGN_TRADER_URL_BASE ?? 'https://example.invalid/gmgn/trader'
} as const;

export type SourceName = 'meteora' | 'pump' | 'gmgn';

export type WithSourceMetadata<T extends Record<string, unknown>> = T & {
  source: SourceName;
  capturedAt: string;
  raw: T;
};

export function withSourceMetadata<T extends Record<string, unknown>>(
  source: SourceName,
  payload: T,
  capturedAt = new Date().toISOString()
): WithSourceMetadata<T> {
  return {
    ...payload,
    source,
    capturedAt,
    raw: payload
  };
}
