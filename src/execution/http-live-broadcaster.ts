import type { FetchImpl } from '../ingest/shared/http-client.ts';
import type { LiveBroadcaster, LiveBroadcastResult } from './live-broadcaster.ts';
import type { SignedLiveOrderIntent } from './live-signer.ts';
import { executeWithRetry } from './request-resilience.ts';

type HttpLiveBroadcasterOptions = {
  url: string;
  authToken?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxRetries?: number;
};

export class HttpLiveBroadcaster implements LiveBroadcaster {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly fetchImpl?: FetchImpl;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: HttpLiveBroadcasterOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 1;
  }

  async broadcast(intent: SignedLiveOrderIntent): Promise<LiveBroadcastResult> {
    return executeWithRetry(async (signal) => {
      const response = await (this.fetchImpl ?? fetch)(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
        },
        body: JSON.stringify({ intent }),
        signal
      });

      if (!response.ok) {
        throw Object.assign(
          new Error(`Broadcast request failed: ${response.status} ${response.statusText}`.trim()),
          { status: response.status }
        );
      }

      return response.json() as Promise<LiveBroadcastResult>;
    }, {
      operation: 'broadcast',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }
}
