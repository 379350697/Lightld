import { createHmac } from 'node:crypto';

import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from '@solana/web3.js';

import type { FetchImpl } from '../../ingest/shared/http-client.ts';
import { encodeBase58 } from '../../shared/base58.ts';
import {
  JupiterClient,
  JupiterNoRouteError,
  JupiterQuoteAmountTooSmallError,
  SOL_MINT
} from './jupiter-client.ts';
import type { JupiterOrderResponse, JupiterQuoteResponse } from './jupiter-client.ts';
import type { MeteoraDlmmClient } from './meteora-dlmm-client.ts';
import type { SolanaRpcClient } from './solana-rpc-client.ts';
import { signSwapTransaction } from './solana-transaction-signer.ts';

export type SwapProviderName =
  | 'meteora-dlmm-direct'
  | 'jupiter-v2'
  | 'raydium'
  | 'okx'
  | 'jupiter-v1';

export type SwapExactInRequest = {
  inputMint: string;
  outputMint: string;
  amountLamports: string;
  walletPublicKey: string;
  poolAddress?: string;
  slippageBps: number;
  jitoTipLamports?: number;
  skipBalanceDependentProviders?: boolean;
};

export type SwapQuoteResult = {
  providerName: SwapProviderName;
  outAmountLamports: string;
  minOutAmountLamports?: string;
  priceImpactPct?: number;
  providerAttempts?: SwapProviderAttempt[];
};

export type SwapExecuteResult = SwapQuoteResult & {
  signature: string;
  signedTransactionBase64?: string;
};

export type SwapProviderAttempt = {
  providerName: SwapProviderName;
  status: 'skipped' | 'failed' | 'succeeded';
  reason?: string;
  retryable?: boolean;
};

export type SwapExecutionContext = {
  keypair: Keypair;
  rpcClient: SolanaRpcClient;
  sendRawTransaction: (signedTransactionBase64: string) => Promise<string>;
};

export type SwapExecutionProvider = {
  readonly name: SwapProviderName;
  enabled(): boolean;
  disabledReason?(): string | undefined;
  quoteExactIn(request: SwapExactInRequest): Promise<SwapQuoteResult>;
  executeExactIn(request: SwapExactInRequest, context: SwapExecutionContext): Promise<SwapExecuteResult>;
};

type ProviderFailureClassification = {
  retryable: boolean;
  noRoute: boolean;
  cooldown: boolean;
  skip: boolean;
  reason: string;
};

type RaydiumSwapResponse = {
  success?: boolean;
  msg?: string;
  data?: {
    outputAmount?: string;
    otherAmountThreshold?: string;
    priceImpactPct?: number | string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type RaydiumTransactionResponse = {
  success?: boolean;
  msg?: string;
  data?: Array<{ transaction?: string }>;
  [key: string]: unknown;
};

type OkxInstruction = {
  data: string;
  programId: string;
  accounts?: Array<{
    pubkey: string;
    isSigner?: boolean;
    isWritable?: boolean;
  }>;
};

const OKX_NATIVE_SOL_ADDRESS = '11111111111111111111111111111111';
const DEFAULT_PROVIDER_ORDER = [
  'meteora-direct',
  'jupiter-v2',
  'raydium',
  'okx',
  'jupiter-v1'
];

function parsePositiveIntegerString(value: string) {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`Swap amount must be a positive integer string, received ${value}`);
  }

  return value;
}

function readString(record: unknown, key: string) {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function extractHttpStatus(error: Error) {
  const direct = (error as Error & { status?: unknown }).status;
  if (typeof direct === 'number') {
    return direct;
  }

  const match = error.message.match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function normalizeReason(error: unknown) {
  const message = toError(error).message;
  return message.replace(/\s+/g, ' ').trim();
}

function isPreBroadcastSubmissionFailure(error: unknown) {
  return /Transaction simulation failed|preflight failure|simulate transaction failed/i
    .test(normalizeReason(error));
}

function isNoRouteLike(error: unknown) {
  if (error instanceof JupiterNoRouteError || error instanceof JupiterQuoteAmountTooSmallError) {
    return true;
  }

  const message = normalizeReason(error);
  return /no route|NO_ROUTES_FOUND|CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD|route not found|not enough liquidity/i.test(message);
}

function isMeteoraDirectMismatch(error: unknown) {
  return /requires a pool address|only supports token-to-SOL|not configured|not part of|does not contain|not a SOL pair/i
    .test(normalizeReason(error));
}

function isMeteoraDirectSimulationFailure(error: unknown) {
  return /Transaction simulation failed|custom program error|AccountNotEnoughKeys|insufficient funds/i
    .test(normalizeReason(error));
}

function classifyFailure(providerName: SwapProviderName, error: unknown): ProviderFailureClassification {
  const normalized = toError(error);
  const status = extractHttpStatus(normalized);
  const reason = normalizeReason(normalized);

  if (providerName === 'meteora-dlmm-direct' && isMeteoraDirectMismatch(error)) {
    return {
      retryable: false,
      noRoute: false,
      cooldown: false,
      skip: true,
      reason
    };
  }

  if (providerName === 'meteora-dlmm-direct' && isMeteoraDirectSimulationFailure(error)) {
    return {
      retryable: false,
      noRoute: false,
      cooldown: true,
      skip: false,
      reason
    };
  }

  if (isNoRouteLike(error)) {
    return {
      retryable: false,
      noRoute: true,
      cooldown: false,
      skip: false,
      reason
    };
  }

  if (
    status === 429 ||
    /too many requests|rate.?limit|No RPC endpoint available/i.test(reason)
  ) {
    return {
      retryable: true,
      noRoute: false,
      cooldown: true,
      skip: false,
      reason
    };
  }

  if (
    /timeout|AbortError/i.test(reason) ||
    (typeof status === 'number' && status >= 500)
  ) {
    return {
      retryable: true,
      noRoute: false,
      cooldown: true,
      skip: false,
      reason
    };
  }

  return {
    retryable: false,
    noRoute: false,
    cooldown: false,
    skip: false,
    reason
  };
}

function signSerializedTransactionBase64(transactionBase64: string, keypair: Keypair) {
  const transactionBuffer = Buffer.from(transactionBase64, 'base64');

  try {
    const transaction = VersionedTransaction.deserialize(transactionBuffer);
    transaction.sign([keypair]);
    const signed = transaction.serialize();
    return {
      signedTransactionBase64: Buffer.from(signed).toString('base64'),
      localSignature: encodeBase58(transaction.signatures[0])
    };
  } catch {
    const transaction = Transaction.from(transactionBuffer);
    transaction.sign(keypair);
    return {
      signedTransactionBase64: transaction.serialize().toString('base64'),
      localSignature: transaction.signature ? encodeBase58(transaction.signature) : undefined
    };
  }
}

function extractJupiterV2Transaction(order: JupiterOrderResponse) {
  return readString(order, 'transaction')
    ?? readString(order, 'swapTransaction')
    ?? readString(order, 'tx');
}

function extractJupiterV2OutAmount(order: JupiterOrderResponse) {
  return readString(order, 'outAmount')
    ?? readString(order, 'outputAmount')
    ?? readString(order, 'outputAmountResult');
}

function extractJupiterV2MinOutAmount(order: JupiterOrderResponse) {
  return readString(order, 'otherAmountThreshold')
    ?? readString(order, 'minOutAmount')
    ?? readString(order, 'minReceiveAmount');
}

function extractJupiterV2PriceImpact(order: JupiterOrderResponse) {
  return readNumber(order.priceImpactPct);
}

function buildRaydiumUrl(apiUrl: string, path: string, query?: URLSearchParams) {
  return `${apiUrl.replace(/\/$/, '')}${path}${query ? `?${query.toString()}` : ''}`;
}

function parseJsonResponse<T>(providerName: SwapProviderName, response: Response): Promise<T> {
  if (response.ok) {
    return response.json() as Promise<T>;
  }

  return response.text().then((body) => {
    throw Object.assign(
      new Error(`swap-provider-failed:${providerName}:http-${response.status} ${body}`.trim()),
      { status: response.status }
    );
  });
}

function normalizeOkxMint(mint: string) {
  return mint === SOL_MINT ? OKX_NATIVE_SOL_ADDRESS : mint;
}

function extractOkxData(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (Array.isArray(data)) {
    return data[0] as Record<string, unknown> | undefined;
  }

  return data && typeof data === 'object'
    ? data as Record<string, unknown>
    : undefined;
}

function extractOkxRouterResult(data: Record<string, unknown> | undefined) {
  const routerResult = data?.routerResult;
  if (routerResult && typeof routerResult === 'object') {
    return routerResult as Record<string, unknown>;
  }

  return data;
}

function extractOkxOutAmount(data: Record<string, unknown> | undefined) {
  const routerResult = extractOkxRouterResult(data);
  return readString(routerResult, 'toTokenAmount')
    ?? readString(routerResult, 'outputAmount')
    ?? readString(data, 'toTokenAmount');
}

function extractOkxMinOutAmount(data: Record<string, unknown> | undefined) {
  const tx = data?.tx;
  const txRecord = tx && typeof tx === 'object' ? tx as Record<string, unknown> : undefined;
  return readString(txRecord, 'minReceiveAmount')
    ?? readString(data, 'minReceiveAmount');
}

function providerOrderKey(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'meteora-direct') {
    return 'meteora-dlmm-direct';
  }

  if (
    normalized === 'meteora-dlmm-direct' ||
    normalized === 'jupiter-v2' ||
    normalized === 'raydium' ||
    normalized === 'okx' ||
    normalized === 'jupiter-v1'
  ) {
    return normalized;
  }

  return undefined;
}

export function describeSwapProviderAttempts(attempts: SwapProviderAttempt[] | undefined) {
  return (attempts ?? [])
    .map((attempt) => {
      if (attempt.status === 'succeeded') {
        return `${attempt.providerName}:ok`;
      }

      return `${attempt.providerName}:${attempt.status}${attempt.reason ? `:${attempt.reason}` : ''}`;
    })
    .join('; ');
}

export class SwapProviderChainError extends Error {
  readonly attempts: SwapProviderAttempt[];

  constructor(action: 'quote' | 'execute', attempts: SwapProviderAttempt[]) {
    super(
      `swap-provider-chain-${action}-failed`
      + (attempts.length > 0 ? `: ${describeSwapProviderAttempts(attempts)}` : '')
    );
    this.name = 'SwapProviderChainError';
    this.attempts = attempts;
  }
}

class SwapProviderSubmissionError extends Error {
  readonly providerName: SwapProviderName;
  readonly terminal: boolean;

  constructor(
    providerName: SwapProviderName,
    error: unknown,
    options: { terminal?: boolean } = {}
  ) {
    super(`swap-provider-submission-failed:${providerName}:${normalizeReason(error)}`);
    this.name = 'SwapProviderSubmissionError';
    this.providerName = providerName;
    this.terminal = options.terminal ?? true;

    const status = extractHttpStatus(toError(error));
    if (status !== undefined) {
      (this as Error & { status?: number }).status = status;
    }

    (this as Error & { cause?: unknown }).cause = error;
  }
}

async function submitSignedTransaction(
  providerName: SwapProviderName,
  action: () => Promise<string>
) {
  try {
    return await action();
  } catch (error) {
    throw new SwapProviderSubmissionError(providerName, error, {
      terminal: !isPreBroadcastSubmissionFailure(error)
    });
  }
}

export class SwapProviderChain {
  private readonly providers: SwapExecutionProvider[];
  private readonly cooldownUntilMs = new Map<SwapProviderName, number>();
  private readonly noRouteUntilMs = new Map<string, number>();
  private readonly nowMs: () => number;
  private readonly cooldownMs: number;

  constructor(
    providers: SwapExecutionProvider[],
    options: {
      cooldownMs?: number;
      noRouteTtlMs?: number;
      nowMs?: () => number;
    } = {}
  ) {
    this.providers = providers;
    this.cooldownMs = Math.max(0, Math.floor(options.cooldownMs ?? 30_000));
    this.noRouteTtlMs = Math.max(0, Math.floor(options.noRouteTtlMs ?? this.cooldownMs));
    this.nowMs = options.nowMs ?? Date.now;
  }

  private readonly noRouteTtlMs: number;

  async quoteExactIn(request: SwapExactInRequest): Promise<SwapQuoteResult> {
    parsePositiveIntegerString(request.amountLamports);
    const attempts: SwapProviderAttempt[] = [];

    for (const provider of this.providers) {
      const skipReason = this.readSkipReason(provider, request);
      if (skipReason) {
        attempts.push({
          providerName: provider.name,
          status: 'skipped',
          reason: skipReason
        });
        continue;
      }

      try {
        const result = await provider.quoteExactIn(request);
        const finalAttempts = [
          ...attempts,
          { providerName: provider.name, status: 'succeeded' as const }
        ];
        return {
          ...result,
          providerAttempts: finalAttempts
        };
      } catch (error) {
        this.recordFailure(provider.name, request, error, attempts);
      }
    }

    throw new SwapProviderChainError('quote', attempts);
  }

  async executeExactIn(
    request: SwapExactInRequest,
    context: SwapExecutionContext
  ): Promise<SwapExecuteResult> {
    parsePositiveIntegerString(request.amountLamports);
    const attempts: SwapProviderAttempt[] = [];

    for (const provider of this.providers) {
      const skipReason = this.readSkipReason(provider, request);
      if (skipReason) {
        attempts.push({
          providerName: provider.name,
          status: 'skipped',
          reason: skipReason
        });
        continue;
      }

      try {
        const result = await provider.executeExactIn(request, context);
        const finalAttempts = [
          ...attempts,
          { providerName: provider.name, status: 'succeeded' as const }
        ];
        return {
          ...result,
          providerAttempts: finalAttempts
        };
      } catch (error) {
        this.recordFailure(provider.name, request, error, attempts);
        if (error instanceof SwapProviderSubmissionError && error.terminal) {
          throw new SwapProviderChainError('execute', attempts);
        }
      }
    }

    throw new SwapProviderChainError('execute', attempts);
  }

  private readSkipReason(provider: SwapExecutionProvider, request: SwapExactInRequest) {
    if (!provider.enabled()) {
      return provider.disabledReason?.() ?? 'disabled';
    }

    if (request.skipBalanceDependentProviders && provider.name === 'meteora-dlmm-direct') {
      return 'balance-dependent-provider-skipped-for-valuation';
    }

    const now = this.nowMs();
    const cooldownUntil = this.cooldownUntilMs.get(provider.name) ?? 0;
    if (cooldownUntil > now) {
      return `cooldown-until:${new Date(cooldownUntil).toISOString()}`;
    }

    const noRouteUntil = this.noRouteUntilMs.get(this.routeKey(provider.name, request)) ?? 0;
    if (noRouteUntil > now) {
      return `no-route-cached-until:${new Date(noRouteUntil).toISOString()}`;
    }

    return undefined;
  }

  private recordFailure(
    providerName: SwapProviderName,
    request: SwapExactInRequest,
    error: unknown,
    attempts: SwapProviderAttempt[]
  ) {
    const classification = classifyFailure(providerName, error);
    const status = classification.skip ? 'skipped' : 'failed';
    attempts.push({
      providerName,
      status,
      reason: classification.reason,
      retryable: classification.retryable
    });

    if (classification.cooldown && this.cooldownMs > 0) {
      this.cooldownUntilMs.set(providerName, this.nowMs() + this.cooldownMs);
    }

    if (classification.noRoute && this.noRouteTtlMs > 0) {
      this.noRouteUntilMs.set(
        this.routeKey(providerName, request),
        this.nowMs() + this.noRouteTtlMs
      );
    }
  }

  private routeKey(providerName: SwapProviderName, request: SwapExactInRequest) {
    return `${providerName}|${request.inputMint}|${request.outputMint}`;
  }
}

export class MeteoraDirectSwapProvider implements SwapExecutionProvider {
  readonly name = 'meteora-dlmm-direct' as const;
  private readonly dlmmClient?: MeteoraDlmmClient;

  constructor(dlmmClient?: MeteoraDlmmClient) {
    this.dlmmClient = dlmmClient;
  }

  enabled() {
    return typeof (this.dlmmClient as { swapTokenToSol?: unknown } | undefined)?.swapTokenToSol === 'function';
  }

  disabledReason() {
    return 'meteora-direct-swap-not-configured';
  }

  async quoteExactIn(request: SwapExactInRequest): Promise<SwapQuoteResult> {
    const directSwap = await this.buildDirectSwap(request);
    return {
      providerName: this.name,
      outAmountLamports: directSwap.outAmountLamports,
      minOutAmountLamports: directSwap.minOutAmountLamports,
      priceImpactPct: directSwap.priceImpactPct
    };
  }

  async executeExactIn(
    request: SwapExactInRequest,
    context: SwapExecutionContext
  ): Promise<SwapExecuteResult> {
    const directSwap = await this.buildDirectSwap(request);
    const { value: blockhash } = await context.rpcClient.getLatestBlockhash();
    directSwap.transaction.recentBlockhash = blockhash.blockhash;
    directSwap.transaction.feePayer = context.keypair.publicKey;
    directSwap.transaction.sign(context.keypair);
    const signedTransactionBase64 = directSwap.transaction.serialize().toString('base64');
    const signature = await submitSignedTransaction(
      this.name,
      () => context.sendRawTransaction(signedTransactionBase64)
    );

    return {
      providerName: this.name,
      outAmountLamports: directSwap.outAmountLamports,
      minOutAmountLamports: directSwap.minOutAmountLamports,
      priceImpactPct: directSwap.priceImpactPct,
      signedTransactionBase64,
      signature
    };
  }

  private async buildDirectSwap(request: SwapExactInRequest) {
    if (!this.dlmmClient) {
      throw new Error('Meteora direct swap not configured');
    }

    if (request.outputMint !== SOL_MINT) {
      throw new Error('Meteora direct swap only supports token-to-SOL exact-in');
    }

    if (!request.poolAddress) {
      throw new Error('Meteora direct swap requires a pool address');
    }

    return this.dlmmClient.swapTokenToSol(
      new PublicKey(request.walletPublicKey),
      request.poolAddress,
      request.inputMint,
      request.amountLamports,
      request.slippageBps
    );
  }
}

export class JupiterV2SwapProvider implements SwapExecutionProvider {
  readonly name = 'jupiter-v2' as const;
  private readonly jupiterClient: JupiterClient;

  constructor(jupiterClient: JupiterClient) {
    this.jupiterClient = jupiterClient;
  }

  enabled() {
    return true;
  }

  async quoteExactIn(request: SwapExactInRequest): Promise<SwapQuoteResult> {
    const order = await this.getOrder(request);
    const outAmountLamports = extractJupiterV2OutAmount(order);
    if (!outAmountLamports) {
      throw new Error('Jupiter V2 order did not include an output amount');
    }

    return {
      providerName: this.name,
      outAmountLamports,
      minOutAmountLamports: extractJupiterV2MinOutAmount(order),
      priceImpactPct: extractJupiterV2PriceImpact(order)
    };
  }

  async executeExactIn(request: SwapExactInRequest, context: SwapExecutionContext): Promise<SwapExecuteResult> {
    const order = await this.getOrder(request);
    const transactionBase64 = extractJupiterV2Transaction(order);
    if (!transactionBase64) {
      throw new Error('Jupiter V2 order did not include a transaction');
    }

    if (!order.requestId) {
      throw new Error('Jupiter V2 order did not include a requestId');
    }

    const { signedTransactionBase64 } = signSerializedTransactionBase64(
      transactionBase64,
      context.keypair
    );
    const response = await this.jupiterClient.executeOrderV2({
      requestId: order.requestId,
      signedTransaction: signedTransactionBase64
    });
    const signature = readString(response, 'signature');
    if (!signature) {
      throw new Error('Jupiter V2 execute did not return a signature');
    }

    const failedStatus = typeof response.status === 'string'
      && response.status.length > 0
      && !/^(success|submitted|ok)$/i.test(response.status);
    if (failedStatus) {
      throw new Error(`Jupiter V2 execute failed: ${response.status}`);
    }

    return {
      providerName: this.name,
      outAmountLamports: extractJupiterV2OutAmount(order) ?? '0',
      minOutAmountLamports: extractJupiterV2MinOutAmount(order),
      priceImpactPct: extractJupiterV2PriceImpact(order),
      signedTransactionBase64,
      signature
    };
  }

  private getOrder(request: SwapExactInRequest) {
    return this.jupiterClient.getOrderV2({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amountLamports,
      slippageBps: request.slippageBps,
      swapMode: 'ExactIn',
      taker: request.walletPublicKey
    });
  }
}

export class JupiterV1SwapProvider implements SwapExecutionProvider {
  readonly name = 'jupiter-v1' as const;
  private readonly jupiterClient: JupiterClient;

  constructor(jupiterClient: JupiterClient) {
    this.jupiterClient = jupiterClient;
  }

  enabled() {
    return true;
  }

  async quoteExactIn(request: SwapExactInRequest): Promise<SwapQuoteResult> {
    const quote = await this.getQuote(request);
    return this.toQuoteResult(quote);
  }

  async executeExactIn(request: SwapExactInRequest, context: SwapExecutionContext): Promise<SwapExecuteResult> {
    const quote = await this.getQuote(request);
    const swapResponse = await this.jupiterClient.getSwapTransaction(
      quote,
      request.walletPublicKey,
      { jitoTipLamports: request.jitoTipLamports }
    );
    const signedTransactionBase64 = signSwapTransaction(
      swapResponse.swapTransaction,
      context.keypair
    );
    const signature = await submitSignedTransaction(
      this.name,
      () => context.sendRawTransaction(signedTransactionBase64)
    );

    return {
      ...this.toQuoteResult(quote),
      signedTransactionBase64,
      signature
    };
  }

  private getQuote(request: SwapExactInRequest) {
    return this.jupiterClient.getQuote({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amountLamports,
      slippageBps: request.slippageBps,
      swapMode: 'ExactIn'
    });
  }

  private toQuoteResult(quote: JupiterQuoteResponse): SwapQuoteResult {
    return {
      providerName: this.name,
      outAmountLamports: quote.outAmount,
      minOutAmountLamports: quote.otherAmountThreshold,
      priceImpactPct: readNumber(quote.priceImpactPct)
    };
  }
}

export class RaydiumSwapProvider implements SwapExecutionProvider {
  readonly name = 'raydium' as const;
  private readonly options: {
    apiUrl?: string;
    fetchImpl?: FetchImpl;
    txVersion?: 'V0' | 'LEGACY';
    computeUnitPriceMicroLamports?: string;
  };

  constructor(
    options: {
      apiUrl?: string;
      fetchImpl?: FetchImpl;
      txVersion?: 'V0' | 'LEGACY';
      computeUnitPriceMicroLamports?: string;
    } = {}
  ) {
    this.options = options;
  }

  enabled() {
    return true;
  }

  async quoteExactIn(request: SwapExactInRequest): Promise<SwapQuoteResult> {
    const quote = await this.fetchQuote(request);
    return this.toQuoteResult(quote);
  }

  async executeExactIn(request: SwapExactInRequest, context: SwapExecutionContext): Promise<SwapExecuteResult> {
    const quote = await this.fetchQuote(request);
    const response = await this.fetchTransactions(request, quote);
    const transactions = response.data ?? [];
    if (transactions.length === 0) {
      throw new Error('Raydium transaction response did not include transactions');
    }
    if (transactions.length > 1) {
      throw new Error('Raydium returned multiple transactions; refusing partial multi-transaction submission');
    }

    let signature = '';
    let signedTransactionBase64 = '';
    for (const tx of transactions) {
      if (!tx.transaction) {
        throw new Error('Raydium transaction entry missing serialized transaction');
      }

      const signed = signSerializedTransactionBase64(tx.transaction, context.keypair);
      signedTransactionBase64 = signed.signedTransactionBase64;
      signature = await submitSignedTransaction(
        this.name,
        () => context.sendRawTransaction(signedTransactionBase64)
      );
    }

    return {
      ...this.toQuoteResult(quote),
      signedTransactionBase64,
      signature
    };
  }

  private async fetchQuote(request: SwapExactInRequest): Promise<RaydiumSwapResponse> {
    const searchParams = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amountLamports,
      slippageBps: String(request.slippageBps),
      txVersion: this.options.txVersion ?? 'V0'
    });
    const response = await (this.options.fetchImpl ?? fetch)(
      buildRaydiumUrl(this.options.apiUrl ?? 'https://transaction-v1.raydium.io', '/compute/swap-base-in', searchParams),
      { method: 'GET' }
    );
    const body = await parseJsonResponse<RaydiumSwapResponse>(this.name, response);

    if (body.success === false || !body.data) {
      throw new Error(`Raydium quote failed: ${body.msg ?? 'missing quote data'}`);
    }

    return body;
  }

  private async fetchTransactions(
    request: SwapExactInRequest,
    quote: RaydiumSwapResponse
  ): Promise<RaydiumTransactionResponse> {
    const response = await (this.options.fetchImpl ?? fetch)(
      buildRaydiumUrl(this.options.apiUrl ?? 'https://transaction-v1.raydium.io', '/transaction/swap-base-in'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          swapResponse: quote,
          wallet: request.walletPublicKey,
          txVersion: this.options.txVersion ?? 'V0',
          wrapSol: request.inputMint === SOL_MINT,
          unwrapSol: request.outputMint === SOL_MINT,
          computeUnitPriceMicroLamports: this.options.computeUnitPriceMicroLamports
        })
      }
    );
    const body = await parseJsonResponse<RaydiumTransactionResponse>(this.name, response);

    if (body.success === false || !Array.isArray(body.data)) {
      throw new Error(`Raydium transaction build failed: ${body.msg ?? 'missing transaction data'}`);
    }

    return body;
  }

  private toQuoteResult(quote: RaydiumSwapResponse): SwapQuoteResult {
    const outAmountLamports = quote.data?.outputAmount;
    if (!outAmountLamports) {
      throw new Error('Raydium quote missing outputAmount');
    }

    return {
      providerName: this.name,
      outAmountLamports,
      minOutAmountLamports: quote.data?.otherAmountThreshold,
      priceImpactPct: readNumber(quote.data?.priceImpactPct)
    };
  }
}

export class OkxSwapProvider implements SwapExecutionProvider {
  readonly name = 'okx' as const;
  private readonly options: {
    apiUrl?: string;
    chainIndex?: string;
    apiKey?: string;
    secretKey?: string;
    passphrase?: string;
    projectId?: string;
    fetchImpl?: FetchImpl;
  };

  constructor(
    options: {
      apiUrl?: string;
      chainIndex?: string;
      apiKey?: string;
      secretKey?: string;
      passphrase?: string;
      projectId?: string;
      fetchImpl?: FetchImpl;
    } = {}
  ) {
    this.options = options;
  }

  enabled() {
    return Boolean(this.options.apiKey && this.options.secretKey && this.options.passphrase);
  }

  disabledReason() {
    return 'okx-credentials-missing';
  }

  async quoteExactIn(request: SwapExactInRequest): Promise<SwapQuoteResult> {
    const data = await this.fetchOkxData('/api/v6/dex/aggregator/quote', request);
    const outAmountLamports = extractOkxOutAmount(data);
    if (!outAmountLamports) {
      throw new Error('OKX quote missing output amount');
    }

    return {
      providerName: this.name,
      outAmountLamports,
      minOutAmountLamports: extractOkxMinOutAmount(data),
      priceImpactPct: readNumber(extractOkxRouterResult(data)?.priceImpactPercent)
    };
  }

  async executeExactIn(request: SwapExactInRequest, context: SwapExecutionContext): Promise<SwapExecuteResult> {
    const data = await this.fetchOkxData('/api/v6/dex/aggregator/swap-instruction', request);
    const rawInstructions = data?.instructionLists;
    if (!Array.isArray(rawInstructions) || rawInstructions.length === 0) {
      throw new Error('OKX swap-instruction response missing instructionLists');
    }

    const instructions = rawInstructions.map((instruction) => {
      const parsed = instruction as OkxInstruction;
      return new TransactionInstruction({
        programId: new PublicKey(parsed.programId),
        keys: (parsed.accounts ?? []).map((account) => ({
          pubkey: new PublicKey(account.pubkey),
          isSigner: Boolean(account.isSigner),
          isWritable: Boolean(account.isWritable)
        })),
        data: Buffer.from(parsed.data, 'base64')
      });
    });

    const lookupTableAddresses = Array.isArray(data.addressLookupTableAccount)
      ? data.addressLookupTableAccount.filter((address): address is string => typeof address === 'string')
      : [];
    const lookupTables = [];
    for (const address of lookupTableAddresses) {
      const lookupTable = await context.rpcClient.getAddressLookupTable(address);
      if (!lookupTable) {
        throw new Error(`OKX address lookup table not found: ${address}`);
      }
      lookupTables.push(lookupTable);
    }

    const { value: blockhash } = await context.rpcClient.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: context.keypair.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions
    }).compileToV0Message(lookupTables);
    const transaction = new VersionedTransaction(message);
    transaction.sign([context.keypair]);
    const signedTransactionBase64 = Buffer.from(transaction.serialize()).toString('base64');
    const signature = await submitSignedTransaction(
      this.name,
      () => context.sendRawTransaction(signedTransactionBase64)
    );

    return {
      providerName: this.name,
      outAmountLamports: extractOkxOutAmount(data) ?? '0',
      minOutAmountLamports: extractOkxMinOutAmount(data),
      priceImpactPct: readNumber(extractOkxRouterResult(data)?.priceImpactPercent),
      signedTransactionBase64,
      signature
    };
  }

  private async fetchOkxData(path: string, request: SwapExactInRequest) {
    const query = new URLSearchParams({
      chainIndex: this.options.chainIndex ?? '501',
      amount: request.amountLamports,
      fromTokenAddress: normalizeOkxMint(request.inputMint),
      toTokenAddress: normalizeOkxMint(request.outputMint),
      userWalletAddress: request.walletPublicKey,
      slippagePercent: String(request.slippageBps / 10_000),
      swapMode: 'exactIn'
    });
    const requestPath = `${path}?${query.toString()}`;
    const response = await (this.options.fetchImpl ?? fetch)(
      `${(this.options.apiUrl ?? 'https://web3.okx.com').replace(/\/$/, '')}${requestPath}`,
      {
        method: 'GET',
        headers: this.buildHeaders('GET', requestPath)
      }
    );
    const body = await parseJsonResponse<Record<string, unknown>>(this.name, response);
    if (readString(body, 'code') && readString(body, 'code') !== '0') {
      throw new Error(`OKX API failed: ${readString(body, 'msg') ?? readString(body, 'code')}`);
    }

    const data = extractOkxData(body);
    if (!data) {
      throw new Error('OKX API response missing data');
    }

    return data;
  }

  private buildHeaders(method: 'GET', requestPath: string) {
    const timestamp = new Date().toISOString();
    const prehash = `${timestamp}${method}${requestPath}`;
    const signature = createHmac('sha256', this.options.secretKey ?? '')
      .update(prehash)
      .digest('base64');
    const headers: Record<string, string> = {
      'OK-ACCESS-KEY': this.options.apiKey ?? '',
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': this.options.passphrase ?? ''
    };

    if (this.options.projectId) {
      headers['OK-ACCESS-PROJECT'] = this.options.projectId;
    }

    return headers;
  }
}

export function createDefaultSwapProviderChain(input: {
  providerOrder?: string[];
  jupiterClient: JupiterClient;
  dlmmClient?: MeteoraDlmmClient;
  raydiumTradeApiUrl?: string;
  okxDexApiUrl?: string;
  okxDexChainIndex?: string;
  okxDexApiKey?: string;
  okxDexSecretKey?: string;
  okxDexPassphrase?: string;
  okxDexProjectId?: string;
  cooldownMs?: number;
  noRouteTtlMs?: number;
  fetchImpl?: FetchImpl;
}) {
  const providerFactories: Record<SwapProviderName, () => SwapExecutionProvider> = {
    'meteora-dlmm-direct': () => new MeteoraDirectSwapProvider(input.dlmmClient),
    'jupiter-v2': () => new JupiterV2SwapProvider(input.jupiterClient),
    raydium: () => new RaydiumSwapProvider({
      apiUrl: input.raydiumTradeApiUrl,
      fetchImpl: input.fetchImpl
    }),
    okx: () => new OkxSwapProvider({
      apiUrl: input.okxDexApiUrl,
      chainIndex: input.okxDexChainIndex,
      apiKey: input.okxDexApiKey,
      secretKey: input.okxDexSecretKey,
      passphrase: input.okxDexPassphrase,
      projectId: input.okxDexProjectId,
      fetchImpl: input.fetchImpl
    }),
    'jupiter-v1': () => new JupiterV1SwapProvider(input.jupiterClient)
  };
  const seen = new Set<SwapProviderName>();
  const providers = (input.providerOrder?.length ? input.providerOrder : DEFAULT_PROVIDER_ORDER)
    .map(providerOrderKey)
    .filter((providerName): providerName is SwapProviderName => Boolean(providerName))
    .filter((providerName) => {
      if (seen.has(providerName)) {
        return false;
      }
      seen.add(providerName);
      return true;
    })
    .map((providerName) => providerFactories[providerName]());

  return new SwapProviderChain(providers, {
    cooldownMs: input.cooldownMs,
    noRouteTtlMs: input.noRouteTtlMs
  });
}
