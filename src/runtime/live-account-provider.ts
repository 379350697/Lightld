import type { FetchImpl } from '../ingest/shared/http-client.ts';
import { executeWithRetry } from '../execution/request-resilience.ts';
import { z } from 'zod';

import type { RuntimeLpPositionStatus } from './lp-position-visibility.ts';

export type LiveAccountState = {
  observedAt?: string;
  walletSol: number;
  journalSol: number;
  walletLpPositions?: Array<{
    poolAddress: string;
    positionAddress: string;
    chainPositionAddress?: string;
    positionId?: string;
    openIntentId?: string;
    mint: string;
    lowerBinId?: number;
    upperBinId?: number;
    activeBinId?: number;
    binCount?: number;
    fundedBinCount?: number;
    solSide?: 'tokenX' | 'tokenY';
    solDepletedBins?: number;
    lpSolExposureStatus?: 'sol-heavy' | 'mixed' | 'token-heavy' | 'sol-depleted';
    currentValueSol?: number;
    withdrawSolAmount?: number;
    withdrawTokenAmountLamports?: number;
    withdrawTokenAmountRaw?: string;
    withdrawTokenMint?: string;
    withdrawTokenValueSol?: number;
    liquidityValueSol?: number;
    unclaimedFeeSolAmount?: number;
    unclaimedFeeTokenAmountLamports?: number;
    unclaimedFeeTokenAmountRaw?: string;
    unclaimedFeeTokenMint?: string;
    unclaimedFeeTokenValueSol?: number;
    unclaimedFeeSol?: number;
    unclaimedFeeValueSol?: number;
    claimedFeeValueSol?: number;
    recoverableRentSol?: number;
    lpTotalValueSol?: number;
    exitQuoteValueSol?: number;
    marketValueSol?: number;
    displayValueSol?: number;
    valuationTrust?: 'exit_quote' | 'market_price' | 'fallback_display';
    valuationCompleteness?: 'complete' | 'incomplete' | 'untrusted';
    currentPrice?: number;
    lowerPrice?: number;
    upperPrice?: number;
    priceProgress?: number;
    positionStatus?: RuntimeLpPositionStatus;
    hasLiquidity?: boolean;
    hasClaimableFees?: boolean;
    valuationStatus?: 'ready' | 'unavailable' | 'stale' | 'invalid';
    valuationReason?: string;
    valuationSource?: string;
    lastValuationAt?: string;
  }>;
  journalLpPositions?: Array<{
    poolAddress: string;
    positionAddress: string;
    chainPositionAddress?: string;
    positionId?: string;
    openIntentId?: string;
    mint: string;
    lowerBinId?: number;
    upperBinId?: number;
    activeBinId?: number;
    binCount?: number;
    fundedBinCount?: number;
    solSide?: 'tokenX' | 'tokenY';
    solDepletedBins?: number;
    lpSolExposureStatus?: 'sol-heavy' | 'mixed' | 'token-heavy' | 'sol-depleted';
    currentValueSol?: number;
    withdrawSolAmount?: number;
    withdrawTokenAmountLamports?: number;
    withdrawTokenAmountRaw?: string;
    withdrawTokenMint?: string;
    withdrawTokenValueSol?: number;
    liquidityValueSol?: number;
    unclaimedFeeSolAmount?: number;
    unclaimedFeeTokenAmountLamports?: number;
    unclaimedFeeTokenAmountRaw?: string;
    unclaimedFeeTokenMint?: string;
    unclaimedFeeTokenValueSol?: number;
    unclaimedFeeSol?: number;
    unclaimedFeeValueSol?: number;
    claimedFeeValueSol?: number;
    recoverableRentSol?: number;
    lpTotalValueSol?: number;
    exitQuoteValueSol?: number;
    marketValueSol?: number;
    displayValueSol?: number;
    valuationTrust?: 'exit_quote' | 'market_price' | 'fallback_display';
    valuationCompleteness?: 'complete' | 'incomplete' | 'untrusted';
    currentPrice?: number;
    lowerPrice?: number;
    upperPrice?: number;
    priceProgress?: number;
    positionStatus?: RuntimeLpPositionStatus;
    hasLiquidity?: boolean;
    hasClaimableFees?: boolean;
    valuationStatus?: 'ready' | 'unavailable' | 'stale' | 'invalid';
    valuationReason?: string;
    valuationSource?: string;
    lastValuationAt?: string;
  }>;
  walletTokens?: Array<{
    mint: string;
    symbol?: string;
    amount: number;
    amountLamports?: number;
    amountRaw?: string;
    currentValueSol?: number;
  }>;
  journalTokens?: Array<{
    mint: string;
    symbol?: string;
    amount: number;
    amountLamports?: number;
    amountRaw?: string;
    currentValueSol?: number;
  }>;
  fills?: Array<{
    submissionId?: string;
    confirmationSignature?: string;
    openIntentId?: string;
    positionId?: string;
    chainPositionAddress?: string;
    mint: string;
    symbol?: string;
    side: 'buy' | 'sell' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';
    amount: number;
    actualFilledSol?: number;
    actualWalletDeltaSol?: number;
    acquiredTokenAmountRaw?: string;
    fillAmountSource?: 'wallet-delta' | 'chain-reconstructed' | 'requested-position-fallback';
    hasFillEvidence?: boolean;
    preWalletSol?: number;
    postWalletSol?: number;
    recordedAt: string;
  }>;
};

const AccountLpPositionSchema = z.object({
  poolAddress: z.string(),
  positionAddress: z.string(),
  mint: z.string()
}).passthrough();

const AccountTokenSchema = z.object({
  mint: z.string(),
  amount: z.number().finite(),
  amountRaw: z.string().regex(/^\d+$/).optional()
}).passthrough();

const AccountFillSchema = z.object({
  mint: z.string(),
  side: z.enum(['buy', 'sell', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']),
  amount: z.number().finite(),
  recordedAt: z.string().min(1)
}).passthrough();

export const LiveAccountStateSchema = z.object({
  observedAt: z.string().min(1).refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'observedAt must be a valid timestamp'
  }),
  walletSol: z.number().finite(),
  journalSol: z.number().finite(),
  walletLpPositions: z.array(AccountLpPositionSchema),
  journalLpPositions: z.array(AccountLpPositionSchema),
  walletTokens: z.array(AccountTokenSchema),
  journalTokens: z.array(AccountTokenSchema),
  fills: z.array(AccountFillSchema)
}).passthrough();

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

      return LiveAccountStateSchema.parse(await response.json()) as LiveAccountState;
    }, {
      operation: 'account',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }
}
