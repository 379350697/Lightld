import type { FetchImpl } from '../../ingest/shared/http-client.ts';
import {
  classifyRetryableRpcError,
  type RpcEndpointRegistry
} from '../rpc-endpoint-registry.ts';
import {
  InMemorySlidingWindowRateLimiter,
  type SlidingWindowRateLimiter
} from './sliding-window-rate-limiter.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export type JupiterQuoteParams = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  swapMode?: 'ExactIn' | 'ExactOut';
};

export type JupiterQuoteResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  [key: string]: unknown;
};

export type JupiterSwapResponse = {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
};

export type JupiterOrderResponse = {
  requestId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  swapType: string;
  priceImpactPct: string;
  routePlan: unknown[];
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  [key: string]: unknown;
};

type JupiterClientOptions = {
  apiUrl?: string;
  apiKey?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  endpointRegistry?: RpcEndpointRegistry;
  rateLimitCapacity?: number;
  rateLimitWindowMs?: number;
  negativeRouteCacheTtlMs?: number;
  minQuoteAmountLamports?: number | string | bigint;
  nowMs?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  rateLimiter?: SlidingWindowRateLimiter;
};

export const LAMPORTS_PER_SOL = 1_000_000_000;

const DEFAULT_RATE_LIMIT_CAPACITY = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_NEGATIVE_ROUTE_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MIN_QUOTE_AMOUNT_LAMPORTS = 1_000n;

const NO_ROUTE_ERROR_CODES = new Set([
  'NO_ROUTES_FOUND',
  'CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD'
]);

export { SOL_MINT };

function normalizeQuoteAmount(amount: number | string | bigint) {
  if (typeof amount === 'bigint') {
    if (amount <= 0n) {
      throw new Error('Jupiter quote amount must be positive');
    }

    return amount.toString();
  }

  if (typeof amount === 'string') {
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      throw new Error('Jupiter quote amount must be a positive integer string');
    }

    return amount;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Jupiter quote amount must be positive');
  }

  return String(Math.floor(amount));
}

function normalizeLamportsOption(amount: number | string | bigint | undefined, fallback: bigint) {
  if (amount === undefined) {
    return fallback;
  }

  if (typeof amount === 'bigint') {
    return amount >= 0n ? amount : fallback;
  }

  if (typeof amount === 'string') {
    return /^\d+$/.test(amount) ? BigInt(amount) : fallback;
  }

  return Number.isFinite(amount) && amount >= 0 ? BigInt(Math.floor(amount)) : fallback;
}

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function parseRetryAfterMs(value: string | null) {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(value);
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return undefined;
}

function normalizeJupiterErrorCode(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const direct = record.errorCode ?? record.code;
  if (typeof direct === 'string') {
    return direct;
  }

  const error = record.error;
  if (error && typeof error === 'object') {
    const nested = error as Record<string, unknown>;
    if (typeof nested.errorCode === 'string') {
      return nested.errorCode;
    }
    if (typeof nested.code === 'string') {
      return nested.code;
    }
  }

  return undefined;
}

function parseJsonPayload(text: string) {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class JupiterNoRouteError extends Error {
  readonly status?: number;
  readonly errorCode: string;

  constructor(message: string, errorCode: string, status?: number) {
    super(message);
    this.name = 'JupiterNoRouteError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

export class JupiterQuoteAmountTooSmallError extends Error {
  readonly amount: string;
  readonly minimumAmount: string;

  constructor(amount: string, minimumAmount: string) {
    super(`Jupiter quote amount below minimum: amount=${amount} minimum=${minimumAmount}`);
    this.name = 'JupiterQuoteAmountTooSmallError';
    this.amount = amount;
    this.minimumAmount = minimumAmount;
  }
}

export function isJupiterNoRouteError(error: unknown): error is JupiterNoRouteError {
  return error instanceof JupiterNoRouteError;
}

export class JupiterClient {
  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private readonly endpointRegistry?: RpcEndpointRegistry;
  private readonly rateLimitCapacity: number;
  private readonly rateLimitWindowMs: number;
  private readonly negativeRouteCacheTtlMs: number;
  private readonly minQuoteAmountLamports: bigint;
  private readonly nowMs: () => number;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly negativeRouteCache = new Map<string, { expiresAt: number; errorCode: string }>();

  constructor(options: JupiterClientOptions = {}) {
    this.apiUrl = (options.apiUrl ?? 'https://api.jup.ag').replace(/\/$/, '');
    // Legacy: quote-api.jup.ag → api.jup.ag (old domain TLS broken through proxy)
    if (this.apiUrl.includes('quote-api.jup.ag')) {
      this.apiUrl = 'https://api.jup.ag';
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.endpointRegistry = options.endpointRegistry;
    this.rateLimitCapacity = Math.max(1, Math.floor(options.rateLimitCapacity ?? DEFAULT_RATE_LIMIT_CAPACITY));
    this.rateLimitWindowMs = Math.max(1, Math.floor(options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS));
    this.negativeRouteCacheTtlMs = Math.max(0, Math.floor(options.negativeRouteCacheTtlMs ?? DEFAULT_NEGATIVE_ROUTE_CACHE_TTL_MS));
    this.minQuoteAmountLamports = normalizeLamportsOption(
      options.minQuoteAmountLamports,
      DEFAULT_MIN_QUOTE_AMOUNT_LAMPORTS
    );
    this.nowMs = options.nowMs ?? Date.now;
    this.rateLimiter = options.rateLimiter ?? new InMemorySlidingWindowRateLimiter({
      capacity: this.rateLimitCapacity,
      windowMs: this.rateLimitWindowMs,
      nowMs: this.nowMs,
      sleep: options.sleep ?? sleep
    });
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    };

    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    return headers;
  }

  async getQuote(params: JupiterQuoteParams): Promise<JupiterQuoteResponse> {
    this.assertQuoteAmountAllowed(params.amount);
    const negativeCacheKey = this.buildNegativeRouteCacheKey(params);
    const cached = this.readNegativeRouteCache(negativeCacheKey);
    if (cached) {
      throw new JupiterNoRouteError(
        `Jupiter quote no route cached: ${cached.errorCode}`,
        cached.errorCode
      );
    }

    const searchParams = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: String(params.slippageBps ?? 50),
      swapMode: params.swapMode ?? 'ExactIn'
    });
    try {
      return await this.runAgainstEndpoint((apiUrl) =>
        this.executeJsonRequest<JupiterQuoteResponse>(
          `${apiUrl}/swap/v1/quote?${searchParams.toString()}`,
          {
            method: 'GET',
            headers: this.buildHeaders()
          }
        )
      );
    } catch (error) {
      if (isJupiterNoRouteError(error)) {
        this.writeNegativeRouteCache(negativeCacheKey, error.errorCode);
      }

      throw error;
    }
  }

  async getSwapTransaction(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string,
    options: { jitoTipLamports?: number } = {}
  ): Promise<JupiterSwapResponse> {
    const swapBody: Record<string, unknown> = {
      userPublicKey,
      quoteResponse,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
      asLegacyTransaction: false
    };

    if (options.jitoTipLamports && options.jitoTipLamports > 0) {
      swapBody.prioritizationFeeLamports = {
        jitoTipLamports: options.jitoTipLamports
      };
    }
    return this.runAgainstEndpoint((apiUrl) =>
      this.executeJsonRequest<JupiterSwapResponse>(
        `${apiUrl}/swap/v1/swap`,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(swapBody)
        }
      )
    );
  }

  buildBuyQuoteParams(tokenMint: string, solAmount: number, slippageBps = 50): JupiterQuoteParams {
    return {
      inputMint: SOL_MINT,
      outputMint: tokenMint,
      amount: String(Math.floor(solAmount * LAMPORTS_PER_SOL)),
      slippageBps,
      swapMode: 'ExactIn'
    };
  }

  buildSellQuoteParams(tokenMint: string, tokenLamports: number | string | bigint, slippageBps = 50): JupiterQuoteParams {
    return {
      inputMint: tokenMint,
      outputMint: SOL_MINT,
      amount: normalizeQuoteAmount(tokenLamports),
      slippageBps,
      swapMode: 'ExactIn'
    };
  }

  private async runAgainstEndpoint<T>(operation: (apiUrl: string) => Promise<T>) {
    const registry = this.endpointRegistry;
    if (!registry) {
      return operation(this.apiUrl);
    }

    return registry.runWithEndpoint({
      kind: 'jupiter',
      candidates: [this.apiUrl],
      execute: operation,
      classifyError: (error) => classifyRetryableRpcError(error)
    });
  }

  private async waitForRateLimitSlot() {
    await this.rateLimiter.waitForSlot();
  }

  private assertQuoteAmountAllowed(amount: string) {
    const quoteAmount = BigInt(amount);
    if (quoteAmount < this.minQuoteAmountLamports) {
      throw new JupiterQuoteAmountTooSmallError(amount, this.minQuoteAmountLamports.toString());
    }
  }

  private buildNegativeRouteCacheKey(params: JupiterQuoteParams) {
    return [
      params.inputMint,
      params.outputMint,
      params.swapMode ?? 'ExactIn'
    ].join('|');
  }

  private readNegativeRouteCache(key: string) {
    const entry = this.negativeRouteCache.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.nowMs()) {
      this.negativeRouteCache.delete(key);
      return undefined;
    }

    return entry;
  }

  private writeNegativeRouteCache(key: string, errorCode: string) {
    if (this.negativeRouteCacheTtlMs <= 0) {
      return;
    }

    this.negativeRouteCache.set(key, {
      expiresAt: this.nowMs() + this.negativeRouteCacheTtlMs,
      errorCode
    });
  }

  private async executeJsonRequest<T>(url: string, init: RequestInit): Promise<T> {
    await this.waitForRateLimitSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const payload = parseJsonPayload(body);
        const errorCode = normalizeJupiterErrorCode(payload);
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        if (errorCode && NO_ROUTE_ERROR_CODES.has(errorCode)) {
          throw new JupiterNoRouteError(
            `${init.method === 'POST' ? 'Jupiter swap' : 'Jupiter quote'} no route: ${errorCode} ${body}`.trim(),
            errorCode,
            response.status
          );
        }

        throw Object.assign(
          new Error(
            `${init.method === 'POST' ? 'Jupiter swap' : 'Jupiter quote'} failed: ${response.status} ${response.statusText} ${body}`.trim()
          ),
          { status: response.status, retryAfterMs, jupiterErrorCode: errorCode }
        );
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('timeout');
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
