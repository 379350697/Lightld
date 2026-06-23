import type { FetchImpl } from '../ingest/shared/http-client.ts';
import { executeWithRetry } from '../execution/request-resilience.ts';

export type LpEntryEvidenceRequest = {
  walletAddress?: string;
  tokenMint: string;
  poolAddress?: string;
  chainPositionAddress?: string;
  openedAtHint?: string;
  orderSignature?: string;
};

export type LpEntryEvidenceResult =
  | {
      status: 'trusted';
      entrySol: number;
      openedAt: string;
      signature: string;
      source: 'reconstructed_chain';
      poolAddress?: string;
      chainPositionAddress?: string;
    }
  | {
      status: 'not_found' | 'ambiguous';
      reason: string;
    };

export interface LpEntryEvidenceProvider {
  reconstructEntry(input: LpEntryEvidenceRequest): Promise<LpEntryEvidenceResult>;
}

type HttpLpEntryEvidenceProviderOptions = {
  url: string;
  authToken?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxRetries?: number;
};

export class HttpLpEntryEvidenceProvider implements LpEntryEvidenceProvider {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly fetchImpl?: FetchImpl;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: HttpLpEntryEvidenceProviderOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 1;
  }

  async reconstructEntry(input: LpEntryEvidenceRequest): Promise<LpEntryEvidenceResult> {
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
          new Error(`LP entry evidence request failed: ${response.status} ${response.statusText}`.trim()),
          { status: response.status }
        );
      }

      return response.json() as Promise<LpEntryEvidenceResult>;
    }, {
      operation: 'lp-entry-evidence',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }
}

export function deriveLpEntryEvidenceUrl(accountStateUrl: string) {
  return accountStateUrl.endsWith('/account-state')
    ? accountStateUrl.slice(0, -'/account-state'.length) + '/lp-entry-evidence'
    : accountStateUrl.replace(/\/+$/, '') + '/lp-entry-evidence';
}
