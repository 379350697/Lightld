import type { FetchImpl } from '../ingest/shared/http-client.ts';
import { executeWithRetry } from '../execution/request-resilience.ts';

import type { RuntimeLpPositionStatus } from './lp-position-visibility.ts';

export type LiveAccountState = {
  walletSol: number;
  journalSol: number;
  walletLpPositions?: Array<{
    poolAddress: string;
    positionAddress: string;
    mint: string;
    lowerBinId?: number;
    upperBinId?: number;
    activeBinId?: number;
    binCount?: number;
    fundedBinCount?: number;
    solSide?: 'tokenX' | 'tokenY';
    solDepletedBins?: number;
    currentValueSol?: number;
    unclaimedFeeSol?: number;
    currentPrice?: number;
    lowerPrice?: number;
    upperPrice?: number;
    priceProgress?: number;
    positionStatus?: RuntimeLpPositionStatus;
    hasLiquidity?: boolean;
    hasClaimableFees?: boolean;
  }>;
  journalLpPositions?: Array<{
    poolAddress: string;
    positionAddress: string;
    mint: string;
    lowerBinId?: number;
    upperBinId?: number;
    activeBinId?: number;
    binCount?: number;
    fundedBinCount?: number;
    solSide?: 'tokenX' | 'tokenY';
    solDepletedBins?: number;
    currentValueSol?: number;
    unclaimedFeeSol?: number;
    currentPrice?: number;
    lowerPrice?: number;
    upperPrice?: number;
    priceProgress?: number;
    positionStatus?: RuntimeLpPositionStatus;
    hasLiquidity?: boolean;
    hasClaimableFees?: boolean;
  }>;
  walletTokens?: Array<{
    mint: string;
    symbol?: string;
    amount: number;
    currentValueSol?: number;
  }>;
  journalTokens?: Array<{
    mint: string;
    symbol?: string;
    amount: number;
    currentValueSol?: number;
  }>;
  fills?: Array<{
    submissionId?: string;
    confirmationSignature?: string;
    mint: string;
    symbol?: string;
    side: 'buy' | 'sell' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';
    amount: number;
    recordedAt: string;
  }>;
};

export interface LiveAccountStateProvider {
  readState(): Promise<LiveAccountState>;
}

type HttpLiveAccountStateProviderOptions = {
  url: string;
  authToken?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxRetries?: number;
};

export class HttpLiveAccountStateProvider implements LiveAccountStateProvider {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly fetchImpl?: FetchImpl;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: HttpLiveAccountStateProviderOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async readState(): Promise<LiveAccountState> {
    return executeWithRetry(async (signal) => {
      const response = await (this.fetchImpl ?? fetch)(this.url, {
        method: 'GET',
        headers: {
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
        },
        signal
      });

      if (!response.ok) {
        throw Object.assign(
          new Error(`Account state request failed: ${response.status} ${response.statusText}`.trim()),
          { status: response.status }
        );
      }

      return response.json() as Promise<LiveAccountState>;
    }, {
      operation: 'account',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }
}
