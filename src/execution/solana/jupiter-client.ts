import type { FetchImpl } from '../../ingest/shared/http-client.ts';

const SOL_MINT = 'So11111111111111111111111111111111';

export type JupiterQuoteParams = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  swapMode?: 'ExactIn' | 'ExactOut';
};

export type JupiterQuoteResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  [key: string]: unknown;
};

export type JupiterSwapResponse = {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
};

export type JupiterOrderResponse = {
  requestId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  swapType: string;
  priceImpactPct: string;
  routePlan: unknown[];
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  [key: string]: unknown;
};

type JupiterClientOptions = {
  apiUrl?: string;
  apiKey?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
};

export const LAMPORTS_PER_SOL = 1_000_000_000;

export { SOL_MINT };

export class JupiterClient {
  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(options: JupiterClientOptions = {}) {
    this.apiUrl = (options.apiUrl ?? 'https://api.jup.ag').replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    };

    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    return headers;
  }

  async getQuote(params: JupiterQuoteParams): Promise<JupiterQuoteResponse> {
    const searchParams = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: String(params.slippageBps ?? 50),
      swapMode: params.swapMode ?? 'ExactIn'
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(
        `${this.apiUrl}/swap/v2/quote?${searchParams.toString()}`,
        {
          method: 'GET',
          headers: this.buildHeaders(),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Jupiter quote failed: ${response.status} ${response.statusText} ${body}`.trim()
        );
      }

      return response.json() as Promise<JupiterQuoteResponse>;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getSwapTransaction(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string,
    options: { jitoTipLamports?: number } = {}
  ): Promise<JupiterSwapResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const swapBody: Record<string, unknown> = {
      userPublicKey,
      quoteResponse,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
      asLegacyTransaction: false
    };

    if (options.jitoTipLamports && options.jitoTipLamports > 0) {
      swapBody.prioritizationFeeLamports = {
        jitoTipLamports: options.jitoTipLamports
      };
    }

    try {
      const response = await this.fetchImpl(
        `${this.apiUrl}/swap/v2/swap`,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(swapBody),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Jupiter swap failed: ${response.status} ${response.statusText} ${body}`.trim()
        );
      }

      return response.json() as Promise<JupiterSwapResponse>;
    } finally {
      clearTimeout(timeout);
    }
  }

  buildBuyQuoteParams(tokenMint: string, solAmount: number, slippageBps = 50): JupiterQuoteParams {
    return {
      inputMint: SOL_MINT,
      outputMint: tokenMint,
      amount: String(Math.floor(solAmount * LAMPORTS_PER_SOL)),
      slippageBps,
      swapMode: 'ExactIn'
    };
  }

  buildSellQuoteParams(tokenMint: string, solAmount: number, slippageBps = 50): JupiterQuoteParams {
    return {
      inputMint: tokenMint,
      outputMint: SOL_MINT,
      amount: String(Math.floor(solAmount * LAMPORTS_PER_SOL)),
      slippageBps,
      swapMode: 'ExactOut'
    };
  }
}
