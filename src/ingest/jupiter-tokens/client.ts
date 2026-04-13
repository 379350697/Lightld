import { fetchJson, type FetchImpl } from '../shared/http-client.ts';

export type JupiterTokenInfo = {
  address: string;
  name: string;
  symbol: string;
  tags?: string[];
  metrics?: {
    volume24h?: number;
    organicScore?: number;
    // other internal scores
  };
  daily_volume?: number; // legacy v1 format
};

export class JupiterTokensClient {
  private readonly baseUrl = 'https://tokens.jup.ag';
  private readonly fetchImpl: FetchImpl;

  constructor(fetchImpl?: FetchImpl) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * Fetch advanced metrics and verification from Jupiter Tokens API.
   * Rate limited to 1 RPS on free tier, use sparingly on filtered subsets.
   */
  public async getTokenInfo(mint: string): Promise<JupiterTokenInfo | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/token/${mint}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        if (response.status === 404) return null; // Unrecognized/Not indexed yet
        throw new Error(`Jupiter Token API error: ${response.status}`);
      }

      return await response.json() as JupiterTokenInfo;
    } catch (err) {
      console.error(`[Jupiter] Failed to fetch info for ${mint}:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Helper to check if a token is verified by Jupiter
   */
  public isVerified(info: JupiterTokenInfo): boolean {
    return Array.isArray(info.tags) && (info.tags.includes('verified') || info.tags.includes('strict'));
  }
}
