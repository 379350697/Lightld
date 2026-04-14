import type { FetchImpl } from '../ingest/shared/http-client.ts';
import { executeWithRetry } from './request-resilience.ts';
import type { LiveOrderIntent, LiveSigner, SignedLiveOrderIntent } from './live-signer.ts';

type HttpLiveSignerOptions = {
  url: string;
  authToken?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxRetries?: number;
};

type SignerResponse = {
  signerId: string;
  signedAt: string;
  signature: string;
};

export class HttpLiveSigner implements LiveSigner {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly fetchImpl?: FetchImpl;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: HttpLiveSignerOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.maxRetries = options.maxRetries ?? 1;
  }

  async sign(intent: LiveOrderIntent): Promise<SignedLiveOrderIntent> {
    const payload = await executeWithRetry(async (signal) => {
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
          new Error(`Sign request failed: ${response.status} ${response.statusText}`.trim()),
          { status: response.status }
        );
      }

      return response.json() as Promise<SignerResponse>;
    }, {
      operation: 'signer',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });

    return {
      intent,
      signerId: payload.signerId,
      signedAt: payload.signedAt,
      signature: payload.signature
    };
  }
}
