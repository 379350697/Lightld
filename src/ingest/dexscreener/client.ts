import { fetchJson, type FetchImpl } from '../shared/http-client.ts';

export type DexScreenerPair = {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
};

export class DexScreenerClient {
  private readonly baseUrl = 'https://api.dexscreener.com/tokens/v1/solana';
  private readonly fetchImpl: FetchImpl;

  constructor(fetchImpl?: FetchImpl) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * Fetches pairs for up to 30 tokens from DexScreener.
   * If a token has multiple pairs, DexScreener returns them all. 
   */
  public async getTokensData(mints: string[]): Promise<DexScreenerPair[]> {
    if (mints.length === 0) return [];
    if (mints.length > 30) {
      throw new Error(`DexScreener batch fetch limit is 30, got ${mints.length}`);
    }

    const path = `${this.baseUrl}/${mints.join(',')}`;
    try {
      const response = await this.fetchImpl(path, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`DexScreener API error: ${response.status}`);
      }

      const data = await response.json() as DexScreenerPair[];
      return data;
    } catch (err) {
      console.error('[DexScreener] Failed to fetch:', (err as Error).message);
      return [];
    }
  }
}
