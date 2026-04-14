import type { FetchImpl } from '../ingest/shared/http-client.ts';
import type { AlertSink } from './alert-sink.ts';
import { executeWithRetry } from '../execution/request-resilience.ts';

type HttpAlertSinkOptions = {
  url: string;
  authToken?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxRetries?: number;
};

export class HttpAlertSink implements AlertSink {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly fetchImpl?: FetchImpl;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: HttpAlertSinkOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.maxRetries = options.maxRetries ?? 1;
  }

  async send(payload: {
    previousMode: string;
    nextMode: string;
    reason: string;
    sentAt: string;
  }): Promise<void> {
    await executeWithRetry(async (signal) => {
      const response = await (this.fetchImpl ?? fetch)(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
        },
        body: JSON.stringify(payload),
        signal
      });

      if (!response.ok) {
        throw Object.assign(
          new Error(`Alert request failed: ${response.status} ${response.statusText}`.trim()),
          { status: response.status }
        );
      }
    }, {
      operation: 'account',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }
}
