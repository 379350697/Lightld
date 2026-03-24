import type { FetchImpl } from '../ingest/shared/http-client.ts';
import { executeWithRetry } from './request-resilience.ts';
import type { CollectLiveQuoteInput, LiveQuoteProvider } from './live-quote-service.ts';
import type { SolExitQuote } from './types.ts';

type HttpLiveQuoteProviderOptions = {
  url: string;
  authToken?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxRetries?: number;
};

export class HttpLiveQuoteProvider implements LiveQuoteProvider {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly fetchImpl?: FetchImpl;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: HttpLiveQuoteProviderOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async collect(input: CollectLiveQuoteInput): Promise<SolExitQuote> {
    return executeWithRetry(async (signal) => {
      const response = await (this.fetchImpl ?? fetch)(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
        },
        body: JSON.stringify(input),
        signal
      });

      if (!response.ok) {
        throw Object.assign(
          new Error(`Quote request failed: ${response.status} ${response.statusText}`.trim()),
          { status: response.status }
        );
      }

      return response.json() as Promise<SolExitQuote>;
    }, {
      operation: 'quote',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }
}
