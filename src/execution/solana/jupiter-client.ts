import type { FetchImpl } from '../../ingest/shared/http-client.ts';
import {
  classifyRetryableRpcError,
  type RpcEndpointRegistry
} from '../rpc-endpoint-registry.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

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
  endpointRegistry?: RpcEndpointRegistry;
};

export const LAMPORTS_PER_SOL = 1_000_000_000;

export { SOL_MINT };

export class JupiterClient {
  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private readonly endpointRegistry?: RpcEndpointRegistry;

  constructor(options: JupiterClientOptions = {}) {
    this.apiUrl = (options.apiUrl ?? 'https://api.jup.ag').replace(/\/$/, '');
    // Legacy: quote-api.jup.ag → api.jup.ag (old domain TLS broken through proxy)
    if (this.apiUrl.includes('quote-api.jup.ag')) {
      this.apiUrl = 'https://api.jup.ag';
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.endpointRegistry = options.endpointRegistry;
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
    return this.runAgainstEndpoint((apiUrl) =>
      this.executeJsonRequest<JupiterQuoteResponse>(
        `${apiUrl}/swap/v1/quote?${searchParams.toString()}`,
        {
          method: 'GET',
          headers: this.buildHeaders()
        }
      )
    );
  }

  async getSwapTransaction(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string,
    options: { jitoTipLamports?: number } = {}
  ): Promise<JupiterSwapResponse> {
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
    return this.runAgainstEndpoint((apiUrl) =>
      this.executeJsonRequest<JupiterSwapResponse>(
        `${apiUrl}/swap/v1/swap`,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(swapBody)
        }
      )
    );
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

  buildSellQuoteParams(tokenMint: string, tokenLamports: number, slippageBps = 50): JupiterQuoteParams {
    return {
      inputMint: tokenMint,
      outputMint: SOL_MINT,
      amount: String(Math.floor(tokenLamports)),
      slippageBps,
      swapMode: 'ExactIn'
    };
  }

  private async runAgainstEndpoint<T>(operation: (apiUrl: string) => Promise<T>) {
    const registry = this.endpointRegistry;
    if (!registry) {
      return operation(this.apiUrl);
    }

    return registry.runWithEndpoint({
      kind: 'jupiter',
      candidates: [this.apiUrl],
      execute: operation,
      classifyError: (error) => classifyRetryableRpcError(error)
    });
  }

  private async executeJsonRequest<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw Object.assign(
          new Error(
            `${init.method === 'POST' ? 'Jupiter swap' : 'Jupiter quote'} failed: ${response.status} ${response.statusText} ${body}`.trim()
          ),
          { status: response.status }
        );
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('timeout');
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
