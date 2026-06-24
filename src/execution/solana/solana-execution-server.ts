import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Keypair } from '@solana/web3.js';

import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from '../../runtime/atomic-file.ts';
import { validateIntentAllowlist } from '../../risk/instruction-allowlist.ts';
import { JupiterClient, LAMPORTS_PER_SOL, SOL_MINT } from './jupiter-client.ts';
import { SolanaRpcClient } from './solana-rpc-client.ts';
import { MeteoraDlmmClient, type MeteoraLpPositionSnapshot } from './meteora-dlmm-client.ts';
import {
  createDefaultSwapProviderChain,
  describeSwapProviderAttempts,
  SwapProviderChain,
  type SwapProviderAttempt
} from './swap-providers.ts';
import {
  createDefaultValuationProviderChain,
  type ValuationProviderChain,
  type ValuationTrust
} from './valuation-providers.ts';
import {
  signedIntentIdempotencyFingerprint,
  verifySignedIntent
} from '../signed-intent-verifier.ts';
import type { LiveBroadcastResult } from '../live-broadcaster.ts';
import type { LiveConfirmationResult } from '../live-confirmation-provider.ts';
import { collectLiveQuote } from '../live-quote-service.ts';
import {
  hasExpectedBearerToken,
  readBody,
  writeJson,
  writeText
} from '../../shared/http-server.ts';
import { reconstructOpenPositionEntryEvidence } from '../../history/solana-closed-position-reconstructor.ts';

const BroadcastRequestSchema = z.object({
  intent: z.object({
    intent: z.object({
      strategyId: z.string().min(1),
      poolAddress: z.string().min(1),
      outputSol: z.number().finite().positive(),
      createdAt: z.string().min(1),
      idempotencyKey: z.string().min(1),
      side: z.enum(['buy', 'sell', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']).optional(),
      tokenMint: z.string().min(1).optional(),
      fullPositionExit: z.boolean().optional(),
      liquidateResidualTokenToSol: z.boolean().optional()
    }),
    signerId: z.string().min(1),
    signedAt: z.string().min(1),
    signature: z.string().min(1)
  })
});

const ConfirmationRequestSchema = z.object({
  submissionId: z.string().min(1),
  confirmationSignature: z.string().optional()
});

const LpEntryEvidenceRequestSchema = z.object({
  walletAddress: z.string().optional(),
  tokenMint: z.string().min(1),
  poolAddress: z.string().optional(),
  chainPositionAddress: z.string().optional(),
  openedAtHint: z.string().optional(),
  orderSignature: z.string().optional()
});

const BroadcastResultSchema = z.object({
  status: z.literal('submitted'),
  submissionId: z.string(),
  idempotencyKey: z.string(),
  confirmationSignature: z.string().optional(),
  submissionIds: z.array(z.string()).optional(),
  confirmationSignatures: z.array(z.string()).optional(),
  batchStatus: z.enum(['complete', 'partial']).optional(),
  reason: z.string().optional()
});

const SubmissionEntrySchema = z.object({
  idempotencyKey: z.string().min(1),
  signedIntentFingerprint: z.string().min(1),
  signedIntent: BroadcastRequestSchema.shape.intent,
  status: z.enum(['pending', 'submitted']).default('submitted'),
  result: BroadcastResultSchema.optional(),
  receivedAt: z.string().min(1),
  updatedAt: z.string().min(1).optional()
});

const SubmissionStoreSchema = z.object({
  submissions: z.array(SubmissionEntrySchema)
});

type SubmissionStore = z.infer<typeof SubmissionStoreSchema>;
type SignedBroadcastIntent = z.infer<typeof BroadcastRequestSchema>['intent'];

type SolanaExecutionServerOptions = {
  host: string;
  port: number;
  stateRootDir?: string;
  keypair: Keypair;
  rpcClient: SolanaRpcClient;
  jupiterClient: JupiterClient;
  dlmmClient?: MeteoraDlmmClient;
  swapProviderChain?: SwapProviderChain;
  valuationProviderChain?: ValuationProviderChain;
  authToken?: string;
  expectedSignerPublicKeys?: string[];
  maxOutputSol?: number;
  defaultSlippageBps?: number;
  jitoTipLamports?: number;
};

type BroadcastLogPayload = {
  event: 'solana-execution-broadcast';
  recordedAt: string;
  strategyId: string;
  idempotencyKey: string;
  side: string;
  poolAddress: string;
  tokenMint?: string;
  outputSol: number;
  result: 'submitted' | 'partial' | 'failed';
  acceptedSignatureCount: number;
  buildMs?: number;
  quoteMs?: number;
  swapBuildMs?: number;
  signMs?: number;
  blockhashMs?: number;
  sendTxMs: number[];
  totalMs: number;
  reason?: string;
  swapProvider?: string;
  swapProviderAttempts?: string;
};

const RESIDUAL_BALANCE_CHECK_DELAY_MS = 2_000;
const WITHDRAW_CONFIRMATION_WAIT_ATTEMPTS = 6;
const WITHDRAW_CONFIRMATION_WAIT_DELAY_MS = 2_000;
const RESIDUAL_TOKEN_SWEEP_PASSES = 3;
const RESIDUAL_TOKEN_DISCOVERY_PASSES = 6;
const RESIDUAL_TOKEN_MIN_SOL_VALUE = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmedSignatures(
  rpcClient: SolanaRpcClient,
  signatures: string[]
) {
  if (signatures.length === 0) {
    return true;
  }

  for (let attempt = 0; attempt < WITHDRAW_CONFIRMATION_WAIT_ATTEMPTS; attempt += 1) {
    const statuses = await rpcClient.getSignatureStatuses(signatures);
    const allConfirmed = statuses.value.every(
      (status) =>
        status &&
        !status.err &&
        (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    );

    if (allConfirmed) {
      return true;
    }

    if (attempt < WITHDRAW_CONFIRMATION_WAIT_ATTEMPTS - 1) {
      await sleep(WITHDRAW_CONFIRMATION_WAIT_DELAY_MS);
    }
  }

  return false;
}

function normalizeLamportsAmount(amount: number | string | bigint | undefined) {
  if (typeof amount === 'bigint') {
    return amount > 0n ? amount.toString() : undefined;
  }

  if (typeof amount === 'string') {
    return /^\d+$/.test(amount) && BigInt(amount) > 0n ? amount : undefined;
  }

  if (typeof amount === 'number') {
    return Number.isFinite(amount) && amount > 0 ? String(Math.floor(amount)) : undefined;
  }

  return undefined;
}

function isZeroLamportsAmount(amount: string | number | undefined) {
  if (typeof amount === 'string') {
    return /^\d+$/.test(amount) && BigInt(amount) === 0n;
  }

  return typeof amount === 'number' && Number.isFinite(amount) && amount === 0;
}

function looksLikeBase58Address(value: string | undefined) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(value);
}

async function resolveLpEntryEvidence(input: {
  rpcClient: SolanaRpcClient;
  walletAddress: string;
  tokenMint: string;
  poolAddress?: string;
  chainPositionAddress?: string;
  openedAtHint?: string;
  orderSignature?: string;
}) {
  const signatures = new Set<string>();

  if (looksLikeBase58Address(input.orderSignature)) {
    signatures.add(input.orderSignature!);
  }

  for (const address of [input.chainPositionAddress, input.poolAddress]) {
    if (!looksLikeBase58Address(address)) {
      continue;
    }

    const candidates = await input.rpcClient.getSignaturesForAddress(address!, { limit: 20 });
    const targetMs = input.openedAtHint ? Date.parse(input.openedAtHint) : Number.NaN;
    const ordered = [...candidates].sort((left, right) => {
      if (!Number.isFinite(targetMs)) {
        return (right.blockTime ?? 0) - (left.blockTime ?? 0);
      }

      const leftMs = typeof left.blockTime === 'number' ? left.blockTime * 1000 : Number.POSITIVE_INFINITY;
      const rightMs = typeof right.blockTime === 'number' ? right.blockTime * 1000 : Number.POSITIVE_INFINITY;
      return Math.abs(leftMs - targetMs) - Math.abs(rightMs - targetMs);
    });

    for (const candidate of ordered) {
      signatures.add(candidate.signature);
    }
  }

  const matches = [];
  for (const signature of signatures) {
    const transaction = await input.rpcClient.getTransaction(signature);
    if (!transaction) {
      continue;
    }

    const evidence = reconstructOpenPositionEntryEvidence({
      walletAddress: input.walletAddress,
      tokenMint: input.tokenMint,
      tokenSymbol: '',
      poolAddress: input.poolAddress,
      positionAddress: input.chainPositionAddress,
      transaction: transaction as Parameters<typeof reconstructOpenPositionEntryEvidence>[0]['transaction']
    });

    if (evidence) {
      matches.push(evidence);
    }
  }

  if (matches.length === 0) {
    return { status: 'not_found' as const, reason: 'lp-entry-evidence-not-found' };
  }

  const exactMatches = matches.filter((match) =>
    (!input.chainPositionAddress || match.positionAddress === input.chainPositionAddress)
    && (!input.poolAddress || match.poolAddress === input.poolAddress)
  );
  const selectedMatches = exactMatches.length > 0 ? exactMatches : matches;

  if (selectedMatches.length > 1) {
    return { status: 'ambiguous' as const, reason: 'entry-reconstruction-ambiguous' };
  }

  const evidence = selectedMatches[0];
  return {
    status: 'trusted' as const,
    entrySol: evidence.entrySol,
    openedAt: evidence.openedAt,
    signature: evidence.signature,
    source: 'reconstructed_chain' as const,
    poolAddress: evidence.poolAddress,
    chainPositionAddress: evidence.positionAddress
  };
}

async function resolveTokenCurrentValueSol(input: {
  swapProviderChain: SwapProviderChain;
  walletPublicKey: string;
  mint: string;
  amountLamports: number | string | bigint;
  defaultSlippageBps: number;
  poolAddress?: string;
  skipBalanceDependentProviders?: boolean;
}) {
  const quoteAmount = normalizeLamportsAmount(input.amountLamports);
  if (!quoteAmount) {
    return undefined;
  }

  const quoteResponse = await input.swapProviderChain.quoteExactIn({
    inputMint: input.mint,
    outputMint: SOL_MINT,
    amountLamports: quoteAmount,
    walletPublicKey: input.walletPublicKey,
    poolAddress: input.poolAddress,
    slippageBps: input.defaultSlippageBps,
    skipBalanceDependentProviders: input.skipBalanceDependentProviders
  });
  const outAmountLamports = Number(quoteResponse.outAmountLamports ?? 0);
  const outAmountSol = outAmountLamports / LAMPORTS_PER_SOL;
  return Number.isFinite(outAmountSol) && outAmountSol >= 0 ? outAmountSol : undefined;
}

type AccountStateLpPosition = MeteoraLpPositionSnapshot & {
  withdrawTokenValueSol?: number;
  exitQuoteValueSol?: number;
  marketValueSol?: number;
  displayValueSol?: number;
  valuationTrust?: ValuationTrust;
};

function readExecutionErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function hasPoolPriceFallbackValue(position: MeteoraLpPositionSnapshot) {
  return typeof position.currentValueSol === 'number'
    && Number.isFinite(position.currentValueSol)
    && position.currentValueSol >= 0
    && typeof position.valuationSource === 'string'
    && position.valuationSource.includes('dlmm-active-bin-price-fallback');
}

function nonnegativeFinite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mergeValuationTrust(current: ValuationTrust, next: ValuationTrust): ValuationTrust {
  if (current === 'fallback_display' || next === 'fallback_display') {
    return 'fallback_display';
  }

  if (current === 'market_price' || next === 'market_price') {
    return 'market_price';
  }

  return 'exit_quote';
}

function markPoolPriceFallbackUntrusted(position: MeteoraLpPositionSnapshot, reason: string): AccountStateLpPosition {
  return {
    ...position,
    valuationStatus: 'stale',
    valuationReason: reason,
    valuationCompleteness: 'untrusted',
    valuationSource: position.valuationSource ?? 'meteora-withdraw-simulation+dlmm-active-bin-price-fallback'
  };
}

function markLpValuationUnavailable(
  position: MeteoraLpPositionSnapshot,
  valuationSource: string,
  reason: string
): AccountStateLpPosition {
  if (hasPoolPriceFallbackValue(position)) {
    return markPoolPriceFallbackUntrusted(position, reason);
  }

  return {
    ...position,
    currentValueSol: undefined,
    liquidityValueSol: undefined,
    lpTotalValueSol: undefined,
    valuationStatus: 'unavailable',
    valuationReason: reason,
    valuationCompleteness: 'incomplete',
    valuationSource
  };
}

async function enrichLpExitValues(input: {
  positions: MeteoraLpPositionSnapshot[];
  valuationProviderChain: ValuationProviderChain;
  walletPublicKey: string;
  defaultSlippageBps: number;
}): Promise<AccountStateLpPosition[]> {
  return Promise.all(input.positions.map(async (position) => {
    const withdrawSolAmount = nonnegativeFinite(position.withdrawSolAmount);
    const withdrawTokenAmountLamports = nonnegativeFinite(position.withdrawTokenAmountLamports);
    const withdrawTokenAmountRaw = typeof position.withdrawTokenAmountRaw === 'string'
      ? position.withdrawTokenAmountRaw
      : typeof withdrawTokenAmountLamports === 'number'
        ? String(Math.floor(withdrawTokenAmountLamports))
        : undefined;
    const unclaimedFeeSolAmount = nonnegativeFinite(position.unclaimedFeeSolAmount)
      ?? (position.hasClaimableFees === false ? 0 : undefined);
    const unclaimedFeeTokenAmountLamports = nonnegativeFinite(position.unclaimedFeeTokenAmountLamports);
    const unclaimedFeeTokenAmountRaw = typeof position.unclaimedFeeTokenAmountRaw === 'string'
      ? position.unclaimedFeeTokenAmountRaw
      : typeof unclaimedFeeTokenAmountLamports === 'number'
        ? String(Math.floor(unclaimedFeeTokenAmountLamports))
        : '0';
    const claimedFeeValueSol = nonnegativeFinite(position.claimedFeeValueSol) ?? 0;
    const recoverableRentSol = nonnegativeFinite(position.recoverableRentSol) ?? 0;
    const valuationSource = position.valuationSource ?? 'meteora-withdraw-simulation';

    if (typeof withdrawSolAmount !== 'number' || !withdrawTokenAmountRaw) {
      return markLpValuationUnavailable(position, valuationSource, position.valuationReason ?? 'missing-withdraw-simulation');
    }

    if (typeof unclaimedFeeSolAmount !== 'number') {
      return markLpValuationUnavailable(position, valuationSource, 'missing-unclaimed-fee-sol-amount');
    }

    try {
      let withdrawTokenValueSol = 0;
      let unclaimedFeeTokenValueSol = 0;
      let valuationTrust: ValuationTrust = 'exit_quote';
      const valuationSources = ['meteora-withdraw-simulation'];
      let hasMarketValuation = false;

      if (!isZeroLamportsAmount(withdrawTokenAmountRaw)) {
        if (!position.withdrawTokenMint) {
          return markLpValuationUnavailable(position, valuationSource, 'missing-withdraw-token-mint');
        }

        const quotedWithdrawTokenValueSol = await input.valuationProviderChain.quoteTokenToSol({
          inputMint: position.withdrawTokenMint,
          amountLamports: withdrawTokenAmountRaw,
          tokenDecimals: position.withdrawTokenDecimals,
          poolAddress: position.poolAddress,
          slippageBps: input.defaultSlippageBps,
          fallbackDisplayValueSol: position.withdrawTokenValueSol
        });

        if (typeof quotedWithdrawTokenValueSol.valueSol !== 'number') {
          return markLpValuationUnavailable(position, valuationSource, 'withdraw-token-quote-unavailable');
        }

        withdrawTokenValueSol = quotedWithdrawTokenValueSol.valueSol;
        valuationTrust = mergeValuationTrust(valuationTrust, quotedWithdrawTokenValueSol.trust);
        hasMarketValuation ||= quotedWithdrawTokenValueSol.trust === 'market_price';
        valuationSources.push(quotedWithdrawTokenValueSol.source);
      }

      if (!isZeroLamportsAmount(unclaimedFeeTokenAmountRaw)) {
        const feeTokenMint = position.unclaimedFeeTokenMint ?? position.withdrawTokenMint;
        if (!feeTokenMint) {
          return markLpValuationUnavailable(position, valuationSource, 'missing-unclaimed-fee-token-mint');
        }

        const quotedFeeTokenValueSol = await input.valuationProviderChain.quoteTokenToSol({
          inputMint: feeTokenMint,
          amountLamports: unclaimedFeeTokenAmountRaw,
          tokenDecimals: position.unclaimedFeeTokenDecimals ?? position.withdrawTokenDecimals,
          poolAddress: position.poolAddress,
          slippageBps: input.defaultSlippageBps,
          fallbackDisplayValueSol: position.unclaimedFeeTokenValueSol
        });

        if (typeof quotedFeeTokenValueSol.valueSol !== 'number') {
          return markLpValuationUnavailable(position, valuationSource, 'unclaimed-fee-token-quote-unavailable');
        }

        unclaimedFeeTokenValueSol = quotedFeeTokenValueSol.valueSol;
        valuationTrust = mergeValuationTrust(valuationTrust, quotedFeeTokenValueSol.trust);
        hasMarketValuation ||= quotedFeeTokenValueSol.trust === 'market_price';
        valuationSources.push('fee-' + quotedFeeTokenValueSol.source);
      }

      const liquidityValueSol = withdrawSolAmount + withdrawTokenValueSol;
      const unclaimedFeeValueSol = unclaimedFeeSolAmount + unclaimedFeeTokenValueSol;
      const lpTotalValueSol = liquidityValueSol + unclaimedFeeValueSol + claimedFeeValueSol + recoverableRentSol;
      const rentSourceSuffix = recoverableRentSol > 0 && !valuationSource.includes('position-account-rent')
        ? '+position-account-rent'
        : '';
      const valuationStatus = valuationTrust === 'exit_quote' ? 'ready' : 'stale';
      const valuationCompleteness = valuationTrust === 'exit_quote' ? 'complete' : 'untrusted';
      const fullValuationSource = valuationSources.join('+') + rentSourceSuffix;

      return {
        ...position,
        currentValueSol: lpTotalValueSol,
        liquidityValueSol,
        withdrawTokenValueSol,
        unclaimedFeeSolAmount,
        unclaimedFeeTokenAmountRaw,
        unclaimedFeeTokenMint: position.unclaimedFeeTokenMint ?? position.withdrawTokenMint,
        unclaimedFeeTokenValueSol,
        unclaimedFeeValueSol,
        claimedFeeValueSol,
        recoverableRentSol,
        lpTotalValueSol,
        exitQuoteValueSol: valuationTrust === 'exit_quote' ? lpTotalValueSol : undefined,
        marketValueSol: hasMarketValuation ? lpTotalValueSol : undefined,
        displayValueSol: lpTotalValueSol,
        valuationTrust,
        valuationStatus,
        valuationReason: valuationTrust === 'exit_quote' ? '' : `valuation-not-exit-quote:${fullValuationSource}`,
        valuationCompleteness,
        valuationSource: fullValuationSource
      };
    } catch (error) {
      return markLpValuationUnavailable(position, valuationSource, 'withdraw-token-quote-failed:' + readExecutionErrorMessage(error));
    }
  }));
}
const ACCOUNT_STATE_TOKEN_VALUE_CACHE_TTL_MS = 5 * 60_000;
const ACCOUNT_STATE_TOKEN_VALUE_MAX_QUOTES_PER_REQUEST = 3;

type TokenValueCacheEntry = {
  currentValueSol?: number;
  updatedAt: number;
};

function readFreshTokenValueCache(
  cache: Map<string, TokenValueCacheEntry>,
  mint: string,
  now = Date.now()
) {
  const entry = cache.get(mint);
  if (!entry) {
    return undefined;
  }

  if (now - entry.updatedAt > ACCOUNT_STATE_TOKEN_VALUE_CACHE_TTL_MS) {
    return undefined;
  }

  return entry.currentValueSol;
}

function isRateLimitLikeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('429')
    || message.includes('rate-limited')
    || message.includes('no endpoint available');
}

type ResidualTokenSweepResult = {
  unsoldMints: string[];
  failureReasons: string[];
};

async function liquidateResidualTokensToSol(input: {
  rpcClient: SolanaRpcClient;
  swapProviderChain: SwapProviderChain;
  keypair: Keypair;
  walletPublicKey: string;
  defaultSlippageBps: number;
  jitoTipLamports?: number;
  sendRawTransaction: (signedTransactionBase64: string) => Promise<string>;
  sendTxMs: number[];
  acceptedSignatures?: string[];
  excludedMints?: string[];
  poolAddressByMint?: Map<string, string>;
}): Promise<ResidualTokenSweepResult> {
  const soldMints = new Set<string>(input.excludedMints ?? []);
  const failureReasonByMint = new Map<string, string>();

  const listSellableTokens = async () => {
    const tokenAccounts = await input.rpcClient.getTokenAccountsByOwner(input.walletPublicKey);
    return tokenAccounts
      .map((account) => ({
        mint: account.account.data.parsed.info.mint as string,
        amount: Number(account.account.data.parsed.info.tokenAmount.amount)
      }))
      .filter((token) => token.mint !== SOL_MINT && token.amount > 0 && !soldMints.has(token.mint));
  };

  const buildResult = (sellable: { mint: string; amount: number }[]): ResidualTokenSweepResult => {
    const unsoldMints = Array.from(new Set(
      sellable
        .filter((token) => !soldMints.has(token.mint))
        .map((token) => token.mint)
    ));

    return {
      unsoldMints,
      failureReasons: unsoldMints
        .map((mint) => failureReasonByMint.get(mint))
        .filter((reason): reason is string => typeof reason === 'string')
    };
  };

  const expectedMints = Array.from(input.poolAddressByMint?.keys() ?? []);
  const maxPasses = expectedMints.length > 0
    ? Math.max(RESIDUAL_TOKEN_SWEEP_PASSES, RESIDUAL_TOKEN_DISCOVERY_PASSES)
    : RESIDUAL_TOKEN_SWEEP_PASSES;
  const isWaitingForExpectedMint = (sellable: { mint: string }[]) => expectedMints.some((mint) =>
    !soldMints.has(mint) && !sellable.some((token) => token.mint === mint)
  );

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const sellable = await listSellableTokens();

    if (sellable.length === 0) {
      if (isWaitingForExpectedMint(sellable) && pass < maxPasses - 1) {
        await sleep(RESIDUAL_BALANCE_CHECK_DELAY_MS);
        continue;
      }

      return { unsoldMints: [], failureReasons: [] };
    }

    let soldAny = false;

    for (const token of sellable) {
      const poolAddress = input.poolAddressByMint?.get(token.mint);

      try {
        const swapResponse = await input.swapProviderChain.executeExactIn(
          {
            inputMint: token.mint,
            outputMint: SOL_MINT,
            amountLamports: String(token.amount),
            walletPublicKey: input.walletPublicKey,
            poolAddress,
            slippageBps: input.defaultSlippageBps,
            jitoTipLamports: input.jitoTipLamports
          },
          {
            keypair: input.keypair,
            rpcClient: input.rpcClient,
            sendRawTransaction: async (signedTransactionBase64) => {
              const residualSendStartedAt = Date.now();
              const signature = await input.sendRawTransaction(signedTransactionBase64);
              input.sendTxMs.push(durationMs(residualSendStartedAt));
              return signature;
            }
          }
        );
        const outAmountSol = Number(swapResponse.outAmountLamports ?? 0) / LAMPORTS_PER_SOL;
        if (Number.isFinite(outAmountSol) && outAmountSol <= RESIDUAL_TOKEN_MIN_SOL_VALUE) {
          console.warn(`[Execution] Residual token liquidation returned zero SOL value for ${token.mint}`);
        }
        const signature = swapResponse.signature;
        input.acceptedSignatures?.push(signature);
        soldMints.add(token.mint);
        failureReasonByMint.delete(token.mint);
        soldAny = true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failureReasonByMint.set(
          token.mint,
          `${token.mint}: ${reason}`
        );
        console.warn(`[Execution] Residual token liquidation skipped for ${token.mint}: ${reason}`);
      }
    }

    if (!soldAny) {
      if (isWaitingForExpectedMint(sellable) && pass < maxPasses - 1) {
        await sleep(RESIDUAL_BALANCE_CHECK_DELAY_MS);
        continue;
      }

      return buildResult(sellable);
    }

    await sleep(RESIDUAL_BALANCE_CHECK_DELAY_MS);
  }

  return buildResult(await listSellableTokens());
}

function durationMs(startedAt: number) {
  return Math.max(0, Date.now() - startedAt);
}

function logBroadcastOutcome(payload: BroadcastLogPayload) {
  const line = JSON.stringify(payload);

  if (payload.result === 'failed') {
    console.error(line);
    return;
  }

  if (payload.result === 'partial') {
    console.warn(line);
    return;
  }

  console.info(line);
}

class SolanaExecutionStateStore {
  private readonly path: string | undefined;
  private memoryStore: SubmissionStore = { submissions: [] };

  constructor(rootDir: string | undefined) {
    this.path = rootDir ? join(rootDir, 'solana-execution-submissions.json') : undefined;
  }

  async read() {
    if (!this.path) {
      return this.memoryStore;
    }

    return (await readJsonIfExists(this.path, SubmissionStoreSchema)) ?? {
      submissions: []
    } satisfies SubmissionStore;
  }

  async write(store: SubmissionStore) {
    const parsed = SubmissionStoreSchema.parse(store);

    if (!this.path) {
      this.memoryStore = parsed;
      return;
    }

    await writeJsonAtomically(this.path, parsed);
  }
}

export function createSolanaExecutionServer(options: SolanaExecutionServerOptions) {
  const {
    keypair,
    rpcClient,
    jupiterClient,
    defaultSlippageBps = 100
  } = options;
  const walletPublicKey = keypair.publicKey.toBase58();
  let server: Server | undefined;
  let origin = '';
  const store = new SolanaExecutionStateStore(options.stateRootDir);
  const expectedSignerPublicKeys = options.expectedSignerPublicKeys ?? [];
  const idempotencyLocks = new Map<string, Promise<void>>();
  const tokenValueCache = new Map<string, TokenValueCacheEntry>();
  const swapProviderChain = options.swapProviderChain ?? createDefaultSwapProviderChain({
    providerOrder: ['meteora-direct', 'jupiter-v1'],
    jupiterClient,
    dlmmClient: options.dlmmClient
  });
  const valuationProviderChain = options.valuationProviderChain ?? createDefaultValuationProviderChain({
    providerOrder: ['meteora-dlmm-quote-only', 'dlmm-active-bin-display-fallback'],
    dlmmClient: options.dlmmClient
  });
  const toTransactionBatch = (txParams: unknown) => Array.isArray(txParams) ? txParams : [txParams];
  const buildSubmittedBroadcastResult = (input: {
    idempotencyKey: string;
    signatures: string[];
    batchStatus?: 'complete' | 'partial';
    reason?: string;
  }): LiveBroadcastResult => ({
    status: 'submitted',
    submissionId: input.signatures[input.signatures.length - 1] ?? '',
    idempotencyKey: input.idempotencyKey,
    confirmationSignature: input.signatures[input.signatures.length - 1],
    submissionIds: input.signatures,
    confirmationSignatures: input.signatures,
    batchStatus: input.batchStatus ?? 'complete',
    reason: input.reason
  });
  const buildFailedBroadcastResult = (input: {
    idempotencyKey: string;
    reason: string;
    retryable?: boolean;
  }): LiveBroadcastResult => ({
    status: 'failed',
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
    retryable: input.retryable ?? true
  });
  const sendVisibleRawTransaction = async (signedTransactionBase64: string) => {
    const visibilitySender = rpcClient as SolanaRpcClient & {
      sendRawTransactionAndWaitForVisibility?: (
        base64Transaction: string
      ) => Promise<{ signature: string }>;
    };

    if (typeof visibilitySender.sendRawTransactionAndWaitForVisibility === 'function') {
      return (await visibilitySender.sendRawTransactionAndWaitForVisibility(signedTransactionBase64)).signature;
    }

    return rpcClient.sendRawTransaction(signedTransactionBase64);
  };
  const withIdempotencyLock = async <T>(idempotencyKey: string, action: () => Promise<T>): Promise<T> => {
    const prior = idempotencyLocks.get(idempotencyKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prior.catch(() => undefined).then(() => current);
    idempotencyLocks.set(idempotencyKey, chained);

    await prior.catch(() => undefined);

    try {
      return await action();
    } finally {
      release();
      if (idempotencyLocks.get(idempotencyKey) === chained) {
        idempotencyLocks.delete(idempotencyKey);
      }
    }
  };

  const reserveIdempotencySubmission = async (signedIntent: SignedBroadcastIntent) => {
    const signedIntentFingerprint = signedIntentIdempotencyFingerprint(signedIntent);
    const idempotencyKey = signedIntent.intent.idempotencyKey;
    const snapshot = await store.read();
    const existing = snapshot.submissions.find(
      (submission) => submission.idempotencyKey === idempotencyKey
    );

    if (existing) {
      if (existing.signedIntentFingerprint !== signedIntentFingerprint) {
        return {
          status: 'conflict' as const
        };
      }

      if (existing.status === 'submitted' && existing.result) {
        return {
          status: 'replay' as const,
          result: existing.result
        };
      }

      return {
        status: 'pending' as const
      };
    }

    const now = new Date().toISOString();
    await store.write({
      submissions: [
        ...snapshot.submissions,
        {
          idempotencyKey,
          signedIntentFingerprint,
          signedIntent,
          status: 'pending',
          receivedAt: now,
          updatedAt: now
        }
      ]
    });

    return {
      status: 'reserved' as const
    };
  };

  const completeIdempotencySubmission = async (
    signedIntent: SignedBroadcastIntent,
    result: LiveBroadcastResult
  ) => {
    const signedIntentFingerprint = signedIntentIdempotencyFingerprint(signedIntent);
    const idempotencyKey = signedIntent.intent.idempotencyKey;
    const snapshot = await store.read();
    const now = new Date().toISOString();
    const parsedResult = BroadcastResultSchema.parse(result);
    let replaced = false;
    const submissions = snapshot.submissions.map((submission) => {
      if (submission.idempotencyKey !== idempotencyKey) {
        return submission;
      }

      replaced = true;
      return {
        ...submission,
        signedIntentFingerprint,
        signedIntent,
        status: 'submitted' as const,
        result: parsedResult,
        updatedAt: now
      };
    });

    if (!replaced) {
      submissions.push({
        idempotencyKey,
        signedIntentFingerprint,
        signedIntent,
        status: 'submitted',
        result: parsedResult,
        receivedAt: now,
        updatedAt: now
      });
    }

    await store.write({ submissions });
  };

  const releaseIdempotencyReservation = async (signedIntent: SignedBroadcastIntent) => {
    const signedIntentFingerprint = signedIntentIdempotencyFingerprint(signedIntent);
    const idempotencyKey = signedIntent.intent.idempotencyKey;
    const snapshot = await store.read();

    await store.write({
      submissions: snapshot.submissions.filter((submission) => !(
        submission.idempotencyKey === idempotencyKey
        && submission.signedIntentFingerprint === signedIntentFingerprint
        && submission.status === 'pending'
      ))
    });
  };

  const writeStoredBroadcastResult = async (
    response: ServerResponse,
    signedIntent: SignedBroadcastIntent,
    result: LiveBroadcastResult
  ) => {
    await completeIdempotencySubmission(signedIntent, result);
    writeJson(response, 200, result);
  };

  return {
    get origin() {
      return origin;
    },
    async start() {
      if (server) {
        return;
      }

      server = createServer(async (request, response) => {
        try {
          // Health check
          if (request.method === 'GET' && request.url === '/health') {
            let solBalance = 0;

            try {
              const lamports = await rpcClient.getBalance(walletPublicKey);
              solBalance = lamports / LAMPORTS_PER_SOL;
            } catch {
              // Non-fatal for health check
            }

            writeJson(response, 200, {
              status: 'ok',
              wallet: walletPublicKey,
              solBalance
            });
            return;
          }

          if (!hasExpectedBearerToken(request, options.authToken)) {
            writeText(response, 401, 'unauthorized');
            return;
          }

          // Broadcast — receive intent, build Jupiter swap, sign, send to Solana
          if (request.method === 'POST' && request.url === '/broadcast') {
            const body = await readBody(request);
            const payload = BroadcastRequestSchema.parse(JSON.parse(body));
            verifySignedIntent(payload.intent, expectedSignerPublicKeys);
            const intent = payload.intent.intent;
            const broadcastStartedAt = Date.now();

            // Allowlist check
            if (options.maxOutputSol !== undefined) {
              const allowlistResult = validateIntentAllowlist(intent, {
                maxOutputSol: options.maxOutputSol
              });

              if (!allowlistResult.allowed) {
                writeJson(response, 403, {
                  error: allowlistResult.reason,
                  detail: allowlistResult.detail
                });
                return;
              }
            }

            await withIdempotencyLock(intent.idempotencyKey, async () => {
              const reservation = await reserveIdempotencySubmission(payload.intent);

              if (reservation.status === 'conflict') {
                writeJson(response, 409, {
                  error: 'idempotency key conflict',
                  detail: `Existing submission for ${intent.idempotencyKey} used a different signed intent`
                });
                return;
              }

              if (reservation.status === 'pending') {
                writeJson(response, 409, {
                  error: 'idempotency key pending',
                  detail: `Submission ${intent.idempotencyKey} is reserved but has no recorded result`
                });
                return;
              }

              if (reservation.status === 'replay') {
                writeJson(response, 200, reservation.result);
                return;
              }

            const side = intent.side ?? 'buy';
            const tokenMint = intent.tokenMint ?? intent.poolAddress;
            let buildMs: number | undefined;
            let quoteMs: number | undefined;
            let swapBuildMs: number | undefined;
            let signMs: number | undefined;
            let blockhashMs: number | undefined;
            const sendTxMs: number[] = [];
            let visibleBroadcastRecorded = false;
            let swapProviderName: string | undefined;
            let swapProviderAttempts: SwapProviderAttempt[] | undefined;

            try {
              let signedBase64 = '';

              if (side === 'buy' || side === 'sell') {
                let inputMint: string;
                let outputMint: string;
                let amountLamports: string;

                if (side === 'buy') {
                  inputMint = SOL_MINT;
                  outputMint = tokenMint;
                  amountLamports = String(Math.floor(intent.outputSol * LAMPORTS_PER_SOL));
                } else {
                  if (!intent.fullPositionExit) {
                    throw new Error('Sell intent must explicitly declare fullPositionExit=true');
                  }

                  // Sell: query actual token balance and sell all
                  const tokenAccounts = await rpcClient.getTokenAccountsByOwner(walletPublicKey);
                  const tokenAccount = tokenAccounts.find(
                    (a) => a.account.data.parsed.info.mint === tokenMint
                  );
                  if (!tokenAccount) {
                    throw new Error(`No token account found for mint ${tokenMint}`);
                  }
                  const tokenLamports = Number(tokenAccount.account.data.parsed.info.tokenAmount.amount);
                  if (tokenLamports <= 0) {
                    throw new Error(`Token balance is zero for mint ${tokenMint}`);
                  }

                  inputMint = tokenMint;
                  outputMint = SOL_MINT;
                  amountLamports = String(tokenLamports);
                }

                const swapStartedAt = Date.now();
                const swapResult = await swapProviderChain.executeExactIn(
                  {
                    inputMint,
                    outputMint,
                    amountLamports,
                    walletPublicKey,
                    poolAddress: intent.poolAddress,
                    slippageBps: defaultSlippageBps,
                    jitoTipLamports: options.jitoTipLamports
                  },
                  {
                    keypair,
                    rpcClient,
                    sendRawTransaction: async (signedTransactionBase64) => {
                      const sendStartedAt = Date.now();
                      const signature = await sendVisibleRawTransaction(signedTransactionBase64);
                      visibleBroadcastRecorded = true;
                      sendTxMs.push(durationMs(sendStartedAt));
                      return signature;
                    }
                  }
                );
                swapBuildMs = durationMs(swapStartedAt);
                swapProviderName = swapResult.providerName;
                swapProviderAttempts = swapResult.providerAttempts;
                visibleBroadcastRecorded = true;

                logBroadcastOutcome({
                  event: 'solana-execution-broadcast',
                  recordedAt: new Date().toISOString(),
                  strategyId: intent.strategyId,
                  idempotencyKey: intent.idempotencyKey,
                  side,
                  poolAddress: intent.poolAddress,
                  tokenMint: intent.tokenMint,
                  outputSol: intent.outputSol,
                  result: 'submitted',
                  acceptedSignatureCount: 1,
                  quoteMs,
                  swapBuildMs,
                  signMs,
                  sendTxMs,
                  totalMs: durationMs(broadcastStartedAt),
                  swapProvider: swapProviderName,
                  swapProviderAttempts: describeSwapProviderAttempts(swapProviderAttempts)
                });

                await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                  idempotencyKey: intent.idempotencyKey,
                  signatures: [swapResult.signature]
                }));
                return;
              } else {
                if (!options.dlmmClient) {
                  throw new Error('DLMM client not configured');
                }

                let txBatch: any[] = [];
                let signers: Keypair[] = [keypair];

              if (side === 'add-lp') {
                const buildStartedAt = Date.now();
                const result = await options.dlmmClient.addLiquidityByStrategy(
                  keypair.publicKey,
                  intent.poolAddress,
                  intent.outputSol
                );
                buildMs = durationMs(buildStartedAt);
                txBatch = toTransactionBatch(result.transaction);
                if (result.newPositionKeypair) {
                  signers.push(result.newPositionKeypair);
                }
              } else if (side === 'withdraw-lp') {
                const buildStartedAt = Date.now();
                txBatch = toTransactionBatch(await options.dlmmClient.removeLiquidity(keypair.publicKey, intent.poolAddress));
                buildMs = durationMs(buildStartedAt);
              } else if (side === 'claim-fee') {
                const buildStartedAt = Date.now();
                txBatch = toTransactionBatch(await options.dlmmClient.claimFee(keypair.publicKey, intent.poolAddress));
                buildMs = durationMs(buildStartedAt);
              } else {
                throw new Error(`Unsupported side: ${side}`);
              }

              if (txBatch.length === 0) {
                throw new Error(`No Meteora transactions returned for side ${side}`);
              }

              const blockhashStartedAt = Date.now();
              const { value: blockhash } = await rpcClient.getLatestBlockhash();
              blockhashMs = durationMs(blockhashStartedAt);
              const txSignatures: string[] = [];

              for (const txParams of txBatch) {
                try {
                  txParams.recentBlockhash = blockhash.blockhash;
                  txParams.feePayer = keypair.publicKey;
                  txParams.sign(...signers);
                  signedBase64 = txParams.serialize().toString('base64');
                  const sendStartedAt = Date.now();
                  txSignatures.push(await sendVisibleRawTransaction(signedBase64));
                  visibleBroadcastRecorded = true;
                  sendTxMs.push(durationMs(sendStartedAt));
                } catch (error) {
                  if (txSignatures.length === 0) {
                    throw error;
                  }

                  options.dlmmClient.invalidatePositionSnapshots?.(keypair.publicKey);
                  const reason = error instanceof Error ? error.message : String(error);
                  logBroadcastOutcome({
                    event: 'solana-execution-broadcast',
                    recordedAt: new Date().toISOString(),
                    strategyId: intent.strategyId,
                    idempotencyKey: intent.idempotencyKey,
                    side,
                    poolAddress: intent.poolAddress,
                    tokenMint: intent.tokenMint,
                    outputSol: intent.outputSol,
                    result: 'partial',
                    acceptedSignatureCount: txSignatures.length,
                    buildMs,
                    blockhashMs,
                    sendTxMs,
                    totalMs: durationMs(broadcastStartedAt),
                    reason
                  });

                  await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                    idempotencyKey: intent.idempotencyKey,
                    signatures: txSignatures,
                    batchStatus: 'partial',
                    reason
                  }));
                  return;
                }
              }

              if ((side === 'withdraw-lp' || side === 'claim-fee') && intent.liquidateResidualTokenToSol && intent.tokenMint) {
                const meteoraConfirmed = await waitForConfirmedSignatures(rpcClient, [...txSignatures]);

                if (!meteoraConfirmed) {
                  const reason = side + ' confirmation not visible before residual token liquidation';
                  options.dlmmClient.invalidatePositionSnapshots?.(keypair.publicKey);
                  logBroadcastOutcome({
                    event: 'solana-execution-broadcast',
                    recordedAt: new Date().toISOString(),
                    strategyId: intent.strategyId,
                    idempotencyKey: intent.idempotencyKey,
                    side,
                    poolAddress: intent.poolAddress,
                    tokenMint: intent.tokenMint,
                    outputSol: intent.outputSol,
                    result: 'partial',
                    acceptedSignatureCount: txSignatures.length,
                    buildMs,
                    blockhashMs,
                    sendTxMs,
                    totalMs: durationMs(broadcastStartedAt),
                    reason
                  });

                  await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                    idempotencyKey: intent.idempotencyKey,
                    signatures: txSignatures,
                    batchStatus: 'partial',
                    reason
                  }));
                  return;
                }

                const residualSweep = await liquidateResidualTokensToSol({
                  rpcClient,
                  swapProviderChain,
                  keypair,
                  walletPublicKey,
                  defaultSlippageBps,
                  jitoTipLamports: options.jitoTipLamports,
                  sendRawTransaction: sendVisibleRawTransaction,
                  sendTxMs,
                  acceptedSignatures: txSignatures,
                  poolAddressByMint: new Map([[intent.tokenMint, intent.poolAddress]])
                });

                if (residualSweep.unsoldMints.length > 0) {
                  const reason = 'residual token sweep incomplete: '
                    + residualSweep.unsoldMints.join(',')
                    + (residualSweep.failureReasons.length > 0 ? ` (${residualSweep.failureReasons.join('; ')})` : '');

                  options.dlmmClient.invalidatePositionSnapshots?.(keypair.publicKey);
                  logBroadcastOutcome({
                    event: 'solana-execution-broadcast',
                    recordedAt: new Date().toISOString(),
                    strategyId: intent.strategyId,
                    idempotencyKey: intent.idempotencyKey,
                    side,
                    poolAddress: intent.poolAddress,
                    tokenMint: intent.tokenMint,
                    outputSol: intent.outputSol,
                    result: 'partial',
                    acceptedSignatureCount: txSignatures.length,
                    buildMs,
                    quoteMs,
                    swapBuildMs,
                    signMs,
                    blockhashMs,
                    sendTxMs,
                    totalMs: durationMs(broadcastStartedAt),
                    reason
                  });

                  await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                    idempotencyKey: intent.idempotencyKey,
                    signatures: txSignatures,
                    batchStatus: 'partial',
                    reason
                  }));
                  return;
                }
              }

              options.dlmmClient.invalidatePositionSnapshots?.(keypair.publicKey);
              logBroadcastOutcome({
                event: 'solana-execution-broadcast',
                recordedAt: new Date().toISOString(),
                strategyId: intent.strategyId,
                idempotencyKey: intent.idempotencyKey,
                side,
                poolAddress: intent.poolAddress,
                tokenMint: intent.tokenMint,
                outputSol: intent.outputSol,
                result: 'submitted',
                acceptedSignatureCount: txSignatures.length,
                buildMs,
                blockhashMs,
                sendTxMs,
                totalMs: durationMs(broadcastStartedAt)
              });

              await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                idempotencyKey: intent.idempotencyKey,
                signatures: txSignatures
              }));
              return;
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);

              logBroadcastOutcome({
                event: 'solana-execution-broadcast',
                recordedAt: new Date().toISOString(),
                strategyId: intent.strategyId,
                idempotencyKey: intent.idempotencyKey,
                side,
                poolAddress: intent.poolAddress,
                tokenMint: intent.tokenMint,
                outputSol: intent.outputSol,
                result: 'failed',
                acceptedSignatureCount: 0,
                buildMs,
                quoteMs,
                swapBuildMs,
                signMs,
                blockhashMs,
                sendTxMs,
                totalMs: durationMs(broadcastStartedAt),
                reason,
                swapProvider: swapProviderName,
                swapProviderAttempts: describeSwapProviderAttempts(swapProviderAttempts)
              });

              if (!visibleBroadcastRecorded) {
                await releaseIdempotencyReservation(payload.intent);
                writeJson(response, 200, buildFailedBroadcastResult({
                  idempotencyKey: intent.idempotencyKey,
                  reason,
                  retryable: true
                }));
                return;
              }

              throw error;
            }
            });
            return;
          }

          // Confirmation — poll Solana RPC for transaction status
          if (request.method === 'POST' && request.url === '/confirmation') {
            const body = await readBody(request);
            const payload = ConfirmationRequestSchema.parse(JSON.parse(body));
            const signature = payload.confirmationSignature ?? payload.submissionId;

            try {
              const statuses = await rpcClient.getSignatureStatusesAcrossReadEndpoints([signature]);
              const status = statuses.value[0];
              const checkedAt = new Date().toISOString();

              if (!status) {
                const result: LiveConfirmationResult = {
                  submissionId: payload.submissionId,
                  confirmationSignature: signature,
                  status: 'submitted',
                  finality: 'unknown',
                  checkedAt
                };
                writeJson(response, 200, result);
                return;
              }

              if (status.err) {
                const result: LiveConfirmationResult = {
                  submissionId: payload.submissionId,
                  confirmationSignature: signature,
                  status: 'failed',
                  finality: 'failed',
                  checkedAt,
                  reason: JSON.stringify(status.err)
                };
                writeJson(response, 200, result);
                return;
              }

              const finality = status.confirmationStatus ?? 'unknown';
              const isConfirmed = finality === 'confirmed' || finality === 'finalized';
              const result: LiveConfirmationResult = {
                submissionId: payload.submissionId,
                confirmationSignature: signature,
                status: isConfirmed ? 'confirmed' : 'submitted',
                finality: finality as LiveConfirmationResult['finality'],
                checkedAt
              };
              writeJson(response, 200, result);
            } catch (error) {
              const result: LiveConfirmationResult = {
                submissionId: payload.submissionId,
                confirmationSignature: signature,
                status: 'unknown',
                finality: 'unknown',
                checkedAt: new Date().toISOString(),
                reason: error instanceof Error ? error.message : String(error)
              };
              writeJson(response, 200, result);
            }
            return;
          }

          if (request.method === 'POST' && request.url === '/lp-entry-evidence') {
            const body = await readBody(request);
            const payload = LpEntryEvidenceRequestSchema.parse(JSON.parse(body));
            const evidence = await resolveLpEntryEvidence({
              rpcClient,
              walletAddress: payload.walletAddress || walletPublicKey,
              tokenMint: payload.tokenMint,
              poolAddress: payload.poolAddress,
              chainPositionAddress: payload.chainPositionAddress,
              openedAtHint: payload.openedAtHint,
              orderSignature: payload.orderSignature
            });
            writeJson(response, 200, evidence);
            return;
          }

          // Account state — query wallet SOL and token balances from RPC
          if (request.method === 'GET' && request.url === '/account-state') {
            const lamports = await rpcClient.getBalance(walletPublicKey);
            const walletSol = lamports / LAMPORTS_PER_SOL;

            let walletTokens: { mint: string; symbol: string; amount: number; currentValueSol?: number }[] = [];
            let walletLpPositions: AccountStateLpPosition[] = [];

            try {
              const tokenAccounts = await rpcClient.getTokenAccountsByOwner(walletPublicKey);
              const now = Date.now();
              const walletTokenCandidates = tokenAccounts.map((account) => {
                const info = account.account.data.parsed.info;
                const amountLamports = Number(info.tokenAmount.amount ?? 0);
                return {
                  mint: info.mint,
                  symbol: '',
                  amount: info.tokenAmount.uiAmount ?? 0,
                  amountLamports,
                  currentValueSol: readFreshTokenValueCache(tokenValueCache, info.mint, now)
                };
              });

              const quoteCandidates = walletTokenCandidates
                .filter((token) => token.amountLamports > 0 && typeof token.currentValueSol !== 'number')
                .sort((left, right) => right.amountLamports - left.amountLamports)
                .slice(0, ACCOUNT_STATE_TOKEN_VALUE_MAX_QUOTES_PER_REQUEST);

              for (const token of quoteCandidates) {
                try {
                  token.currentValueSol = await resolveTokenCurrentValueSol({
                    swapProviderChain,
                    walletPublicKey,
                    mint: token.mint,
                    amountLamports: token.amountLamports,
                    defaultSlippageBps
                  });
                  tokenValueCache.set(token.mint, {
                    currentValueSol: token.currentValueSol,
                    updatedAt: Date.now()
                  });
                } catch (error) {
                  if (isRateLimitLikeError(error)) {
                    break;
                  }
                }
              }

              walletTokens = walletTokenCandidates.map(({ amountLamports: _amountLamports, ...token }) => token);
            } catch {
              // Token accounts query may fail on free RPC
            }

            try {
              if (options.dlmmClient) {
                const dlmmPositions = (await options.dlmmClient.getPositionSnapshots(keypair.publicKey))
                  .filter((position) => position.positionStatus !== 'empty');
                walletLpPositions = await enrichLpExitValues({
                  positions: dlmmPositions,
                  valuationProviderChain,
                  walletPublicKey,
                  defaultSlippageBps
                });
              }
            } catch {
              // Meteora positions query may fail on free RPC
            }

            writeJson(response, 200, {
              walletSol,
              journalSol: walletSol,
              walletLpPositions,
              journalLpPositions: walletLpPositions,
              walletTokens,
              journalTokens: walletTokens,
              fills: []
            });
            return;
          }

          // Quote — strategy-level exit quote (pure calculation, no external call)
          if (request.method === 'POST' && request.url === '/quote') {
            const body = await readBody(request);
            const payload = JSON.parse(body);
            const quote = await collectLiveQuote({
              expectedOutSol: payload.expectedOutSol ?? 0,
              slippageBps: payload.slippageBps ?? 50,
              routeExists: payload.routeExists ?? true
            });
            writeJson(response, 200, quote);
            return;
          }

          writeText(response, 404, 'not-found');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeJson(response, 400, { error: message });
        }
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(options.port, options.host, () => resolve());
      });

      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('Unable to determine Solana execution server address');
      }

      origin = `http://${options.host}:${address.port}`;
    },
    async stop() {
      if (!server) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      server = undefined;
      origin = '';
    }
  };
}
