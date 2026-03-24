import type { FetchImpl } from '../ingest/shared/http-client.ts';
import { executeWithRetry } from './request-resilience.ts';
import type {
  LiveConfirmationPollInput,
  LiveConfirmationProvider,
  LiveConfirmationResult
} from './live-confirmation-provider.ts';

type HttpLiveConfirmationProviderOptions = {
  url: string;
  authToken?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxRetries?: number;
};

export class HttpLiveConfirmationProvider implements LiveConfirmationProvider {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly fetchImpl?: FetchImpl;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: HttpLiveConfirmationProviderOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async poll(input: LiveConfirmationPollInput): Promise<LiveConfirmationResult> {
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
          new Error(`Confirmation request failed: ${response.status} ${response.statusText}`.trim()),
          { status: response.status }
        );
      }

      return response.json() as Promise<LiveConfirmationResult>;
    }, {
      operation: 'confirmation',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }
}
