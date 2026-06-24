import type { FetchImpl } from '../../ingest/shared/http-client.ts';
import { LAMPORTS_PER_SOL, SOL_MINT } from './jupiter-client.ts';
import type { MeteoraDlmmClient } from './meteora-dlmm-client.ts';

export type ValuationTrust = 'exit_quote' | 'market_price' | 'fallback_display';

export type ValuationProviderName =
  | 'meteora-dlmm-quote-only'
  | 'birdeye-price'
  | 'jupiter-price-v3'
  | 'dexscreener-pair'
  | 'geckoterminal-token'
  | 'dlmm-active-bin-display-fallback';

export type ValuationAttempt = {
  providerName: ValuationProviderName;
  status: 'skipped' | 'failed' | 'succeeded';
  reason?: string;
  retryable?: boolean;
};

export type TokenValuationRequest = {
  inputMint: string;
  amountLamports: string;
  tokenDecimals?: number;
  poolAddress?: string;
  slippageBps: number;
  fallbackDisplayValueSol?: number;
};

export type TokenValuationResult = {
  providerName: ValuationProviderName;
  valueSol: number;
  trust: ValuationTrust;
  source: string;
  providerAttempts?: ValuationAttempt[];
};

export type ValuationProvider = {
  readonly name: ValuationProviderName;
  enabled(): boolean;
  disabledReason?(): string | undefined;
  quoteTokenToSol(request: TokenValuationRequest): Promise<TokenValuationResult>;
};

type CooldownEntry = {
  untilMs: number;
  reason: string;
};

const DEFAULT_PROVIDER_ORDER = [
  'meteora-dlmm-quote-only',
  'birdeye-price',
  'jupiter-price-v3',
  'dexscreener-pair',
  'geckoterminal-token',
  'dlmm-active-bin-display-fallback'
];

const WRAPPED_SOL_MINT = SOL_MINT;

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeReason(error: unknown) {
  return toError(error).message.replace(/\s+/g, ' ').trim();
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

function lamportsToUiAmount(amountLamports: string, decimals?: number) {
  if (!/^\d+$/.test(amountLamports) || BigInt(amountLamports) <= 0n) {
    throw new Error(`Valuation amount must be a positive integer string, received ${amountLamports}`);
  }

  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    throw new Error('token decimals required for market-price valuation');
  }

  const amount = Number(amountLamports);
  if (!Number.isFinite(amount)) {
    throw new Error('valuation amount exceeds safe numeric range');
  }

  return amount / (10 ** decimals);
}

async function readJson<T>(fetchImpl: FetchImpl, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`), {
      status: response.status
    });
  }

  return JSON.parse(body) as T;
}

function classifyRetryable(error: unknown) {
  const status = (error as { status?: unknown } | undefined)?.status;
  const reason = normalizeReason(error);
  return status === 429
    || (typeof status === 'number' && status >= 500)
    || /timeout|AbortError|fetch failed|rate.?limit|too many requests|No RPC endpoint available/i.test(reason);
}

function routeKey(providerName: ValuationProviderName, request: TokenValuationRequest) {
  return `${providerName}|${request.poolAddress ?? ''}|${request.inputMint}`;
}

function isPermanentMeteoraQuoteOnlyFailure(reason: string) {
  return /not part of Meteora pool|not a .+\/SOL pair|amount must be positive|requires poolAddress|missing token mints|returned zero SOL output/i.test(reason);
}

export class ValuationProviderChain {
  private readonly cooldownUntil = new Map<ValuationProviderName, CooldownEntry>();
  private readonly negativeCacheUntil = new Map<string, CooldownEntry>();
  private readonly providers: ValuationProvider[];
  private readonly cooldownMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly nowMs: () => number;

  constructor(
    providers: ValuationProvider[],
    options: {
      cooldownMs?: number;
      negativeCacheTtlMs?: number;
      nowMs?: () => number;
    } = {}
  ) {
    this.providers = providers;
    this.cooldownMs = Math.max(0, Math.floor(options.cooldownMs ?? 30_000));
    this.negativeCacheTtlMs = Math.max(0, Math.floor(options.negativeCacheTtlMs ?? 60_000));
    this.nowMs = options.nowMs ?? Date.now;
  }

  async quoteTokenToSol(request: TokenValuationRequest): Promise<TokenValuationResult> {
    const attempts: ValuationAttempt[] = [];

    for (const provider of this.providers) {
      const skipReason = this.readSkipReason(provider, request);
      if (skipReason) {
        attempts.push({ providerName: provider.name, status: 'skipped', reason: skipReason });
        continue;
      }

      try {
        const result = await provider.quoteTokenToSol(request);
        return {
          ...result,
          providerAttempts: [
            ...attempts,
            { providerName: provider.name, status: 'succeeded' as const }
          ]
        };
      } catch (error) {
        const reason = normalizeReason(error);
        const retryable = classifyRetryable(error);
        attempts.push({
          providerName: provider.name,
          status: 'failed',
          reason,
          retryable
        });
        this.recordFailure(provider.name, request, reason, retryable);
      }
    }

    throw new Error(
      'valuation-provider-chain-failed: '
      + attempts.map((attempt) => `${attempt.providerName}:${attempt.status}:${attempt.reason ?? ''}`).join('; ')
    );
  }

  private readSkipReason(provider: ValuationProvider, request: TokenValuationRequest) {
    if (!provider.enabled()) {
      return provider.disabledReason?.() ?? 'disabled';
    }

    const now = this.nowMs();
    const cooldown = this.cooldownUntil.get(provider.name);
    if (cooldown && cooldown.untilMs > now) {
      return `cooldown-until:${new Date(cooldown.untilMs).toISOString()}:${cooldown.reason}`;
    }

    const negative = this.negativeCacheUntil.get(routeKey(provider.name, request));
    if (negative && negative.untilMs > now) {
      return `negative-cache-until:${new Date(negative.untilMs).toISOString()}:${negative.reason}`;
    }

    return undefined;
  }

  private recordFailure(
    providerName: ValuationProviderName,
    request: TokenValuationRequest,
    reason: string,
    retryable: boolean
  ) {
    if (
      providerName === 'meteora-dlmm-quote-only'
      && !isPermanentMeteoraQuoteOnlyFailure(reason)
    ) {
      return;
    }

    if (retryable && this.cooldownMs > 0) {
      this.cooldownUntil.set(providerName, {
        untilMs: this.nowMs() + this.cooldownMs,
        reason
      });
      return;
    }

    if (this.negativeCacheTtlMs > 0) {
      this.negativeCacheUntil.set(routeKey(providerName, request), {
        untilMs: this.nowMs() + this.negativeCacheTtlMs,
        reason
      });
    }
  }
}

export class MeteoraDlmmQuoteOnlyValuationProvider implements ValuationProvider {
  readonly name = 'meteora-dlmm-quote-only' as const;
  private readonly dlmmClient?: MeteoraDlmmClient;

  constructor(dlmmClient?: MeteoraDlmmClient) {
    this.dlmmClient = dlmmClient;
  }

  enabled() {
    return typeof (this.dlmmClient as { quoteTokenToSol?: unknown } | undefined)?.quoteTokenToSol === 'function';
  }

  disabledReason() {
    return 'meteora-dlmm-quote-only-not-configured';
  }

  async quoteTokenToSol(request: TokenValuationRequest): Promise<TokenValuationResult> {
    if (!this.dlmmClient) {
      throw new Error('Meteora quote-only not configured');
    }
    if (!request.poolAddress) {
      throw new Error('Meteora quote-only requires poolAddress');
    }

    const quote = await this.dlmmClient.quoteTokenToSol(
      request.poolAddress,
      request.inputMint,
      request.amountLamports,
      request.slippageBps
    );
    const valueSol = Number(quote.outAmountLamports) / LAMPORTS_PER_SOL;
    if (!Number.isFinite(valueSol) || valueSol <= 0) {
      throw new Error('Meteora quote-only returned invalid SOL value');
    }

    return {
      providerName: this.name,
      valueSol,
      trust: 'exit_quote',
      source: 'meteora-dlmm-swap-quote'
    };
  }
}

export class DexScreenerValuationProvider implements ValuationProvider {
  readonly name = 'dexscreener-pair' as const;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(options: { apiUrl?: string; fetchImpl?: FetchImpl } = {}) {
    this.apiUrl = options.apiUrl ?? 'https://api.dexscreener.com';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  enabled() {
    return true;
  }

  async quoteTokenToSol(request: TokenValuationRequest): Promise<TokenValuationResult> {
    const amountUi = lamportsToUiAmount(request.amountLamports, request.tokenDecimals);
    const pairs = await readJson<Array<Record<string, unknown>>>(
      this.fetchImpl,
      `${this.apiUrl}/token-pairs/v1/solana/${request.inputMint}`
    );
    const pair = selectDexScreenerPair(pairs, request);
    const priceSol = readDexScreenerTokenPriceInSol(pair, request.inputMint);
    if (typeof priceSol !== 'number' || priceSol <= 0) {
      throw new Error('DEXScreener SOL pair price unavailable');
    }

    return {
      providerName: this.name,
      valueSol: amountUi * priceSol,
      trust: 'market_price',
      source: 'dexscreener-pair'
    };
  }
}

export class GeckoTerminalValuationProvider implements ValuationProvider {
  readonly name = 'geckoterminal-token' as const;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(options: { apiUrl?: string; fetchImpl?: FetchImpl } = {}) {
    this.apiUrl = options.apiUrl ?? 'https://api.geckoterminal.com/api/v2';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  enabled() {
    return true;
  }

  async quoteTokenToSol(request: TokenValuationRequest): Promise<TokenValuationResult> {
    const token = await this.fetchToken(request.inputMint);
    const sol = await this.fetchToken(WRAPPED_SOL_MINT);
    const tokenPriceUsd = readNumber(token.attributes?.price_usd);
    const solPriceUsd = readNumber(sol.attributes?.price_usd);
    const decimals = request.tokenDecimals ?? readNumber(token.attributes?.decimals);
    const amountUi = lamportsToUiAmount(request.amountLamports, decimals);
    if (
      typeof tokenPriceUsd !== 'number'
      || tokenPriceUsd <= 0
      || typeof solPriceUsd !== 'number'
      || solPriceUsd <= 0
    ) {
      throw new Error('GeckoTerminal USD price unavailable');
    }

    return {
      providerName: this.name,
      valueSol: amountUi * tokenPriceUsd / solPriceUsd,
      trust: 'market_price',
      source: 'geckoterminal-token'
    };
  }

  private async fetchToken(mint: string): Promise<{ attributes?: Record<string, unknown> }> {
    const payload = await readJson<{ data?: { attributes?: Record<string, unknown> } }>(
      this.fetchImpl,
      `${this.apiUrl}/networks/solana/tokens/${mint}`
    );
    if (!payload.data?.attributes) {
      throw new Error(`GeckoTerminal token not found: ${mint}`);
    }
    return { attributes: payload.data.attributes };
  }
}

export class FallbackDisplayValuationProvider implements ValuationProvider {
  readonly name = 'dlmm-active-bin-display-fallback' as const;

  enabled() {
    return true;
  }

  async quoteTokenToSol(request: TokenValuationRequest): Promise<TokenValuationResult> {
    if (typeof request.fallbackDisplayValueSol !== 'number' || request.fallbackDisplayValueSol < 0) {
      throw new Error('fallback display value unavailable');
    }

    return {
      providerName: this.name,
      valueSol: request.fallbackDisplayValueSol,
      trust: 'fallback_display',
      source: 'dlmm-active-bin-price-fallback'
    };
  }
}

function selectDexScreenerPair(pairs: Array<Record<string, unknown>>, request: TokenValuationRequest) {
  const solPairs = pairs.filter((pair) => readDexScreenerTokenPriceInSol(pair, request.inputMint) !== undefined);
  const exact = solPairs.find((pair) => pair.pairAddress === request.poolAddress);
  if (exact) {
    return exact;
  }

  const sorted = [...solPairs].sort((left, right) =>
    (readNumber((right.liquidity as Record<string, unknown> | undefined)?.usd) ?? 0)
    - (readNumber((left.liquidity as Record<string, unknown> | undefined)?.usd) ?? 0)
  );
  const selected = sorted[0];
  if (!selected) {
    throw new Error('DEXScreener SOL pair not found');
  }
  return selected;
}

function readDexScreenerTokenPriceInSol(pair: Record<string, unknown>, tokenMint: string) {
  const base = pair.baseToken as Record<string, unknown> | undefined;
  const quote = pair.quoteToken as Record<string, unknown> | undefined;
  const baseAddress = typeof base?.address === 'string' ? base.address : '';
  const quoteAddress = typeof quote?.address === 'string' ? quote.address : '';
  const priceNative = readNumber(pair.priceNative);

  if (typeof priceNative !== 'number' || priceNative <= 0) {
    return undefined;
  }

  if (baseAddress === tokenMint && quoteAddress === WRAPPED_SOL_MINT) {
    return priceNative;
  }

  if (quoteAddress === tokenMint && baseAddress === WRAPPED_SOL_MINT) {
    return 1 / priceNative;
  }

  return undefined;
}

export class BirdeyePriceValuationProvider implements ValuationProvider {
  readonly name = 'birdeye-price' as const;
  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchImpl;

  constructor(options: { apiUrl?: string; apiKey?: string; fetchImpl?: FetchImpl } = {}) {
    this.apiUrl = options.apiUrl ?? 'https://public-api.birdeye.so';
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  enabled() {
    return Boolean(this.apiKey);
  }

  disabledReason() {
    return 'birdeye-api-key-missing';
  }

  async quoteTokenToSol(request: TokenValuationRequest): Promise<TokenValuationResult> {
    const amountUi = lamportsToUiAmount(request.amountLamports, request.tokenDecimals);
    const token = await this.fetchPrice(request.inputMint);
    const sol = await this.fetchPrice(WRAPPED_SOL_MINT);
    if (typeof token !== 'number' || typeof sol !== 'number' || token <= 0 || sol <= 0) {
      throw new Error('Birdeye price unavailable');
    }

    return {
      providerName: this.name,
      valueSol: amountUi * token / sol,
      trust: 'market_price',
      source: 'birdeye-price'
    };
  }

  private async fetchPrice(mint: string) {
    const payload = await readJson<{ data?: { value?: unknown } }>(
      this.fetchImpl,
      `${this.apiUrl}/defi/price?address=${mint}`,
      {
        headers: {
          'X-API-KEY': this.apiKey ?? '',
          'x-chain': 'solana'
        }
      }
    );
    return readNumber(payload.data?.value);
  }
}

export class JupiterPriceV3ValuationProvider implements ValuationProvider {
  readonly name = 'jupiter-price-v3' as const;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(options: { apiUrl?: string; fetchImpl?: FetchImpl } = {}) {
    this.apiUrl = options.apiUrl ?? 'https://api.jup.ag';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  enabled() {
    return true;
  }

  async quoteTokenToSol(request: TokenValuationRequest): Promise<TokenValuationResult> {
    const amountUi = lamportsToUiAmount(request.amountLamports, request.tokenDecimals);
    const payload = await readJson<Record<string, unknown>>(
      this.fetchImpl,
      `${this.apiUrl}/price/v3?ids=${request.inputMint},${WRAPPED_SOL_MINT}`
    );
    const tokenPrice = readJupiterPrice(payload, request.inputMint);
    const solPrice = readJupiterPrice(payload, WRAPPED_SOL_MINT);
    if (
      typeof tokenPrice !== 'number'
      || tokenPrice <= 0
      || typeof solPrice !== 'number'
      || solPrice <= 0
    ) {
      throw new Error('Jupiter Price V3 price unavailable');
    }

    return {
      providerName: this.name,
      valueSol: amountUi * tokenPrice / solPrice,
      trust: 'market_price',
      source: 'jupiter-price-v3'
    };
  }
}

function readJupiterPrice(payload: Record<string, unknown>, mint: string) {
  const direct = payload[mint];
  if (typeof direct === 'number' || typeof direct === 'string') {
    return readNumber(direct);
  }

  if (direct && typeof direct === 'object') {
    const record = direct as Record<string, unknown>;
    return readNumber(record.usdPrice)
      ?? readNumber(record.price)
      ?? readNumber(record.priceUsd);
  }

  return undefined;
}

export function createDefaultValuationProviderChain(input: {
  providerOrder?: string[];
  dlmmClient?: MeteoraDlmmClient;
  birdeyeApiUrl?: string;
  birdeyeApiKey?: string;
  jupiterPriceApiUrl?: string;
  dexscreenerApiUrl?: string;
  geckoterminalApiUrl?: string;
  cooldownMs?: number;
  negativeCacheTtlMs?: number;
  fetchImpl?: FetchImpl;
}) {
  const factories: Record<ValuationProviderName, () => ValuationProvider> = {
    'meteora-dlmm-quote-only': () => new MeteoraDlmmQuoteOnlyValuationProvider(input.dlmmClient),
    'birdeye-price': () => new BirdeyePriceValuationProvider({
      apiUrl: input.birdeyeApiUrl,
      apiKey: input.birdeyeApiKey,
      fetchImpl: input.fetchImpl
    }),
    'jupiter-price-v3': () => new JupiterPriceV3ValuationProvider({
      apiUrl: input.jupiterPriceApiUrl,
      fetchImpl: input.fetchImpl
    }),
    'dexscreener-pair': () => new DexScreenerValuationProvider({
      apiUrl: input.dexscreenerApiUrl,
      fetchImpl: input.fetchImpl
    }),
    'geckoterminal-token': () => new GeckoTerminalValuationProvider({
      apiUrl: input.geckoterminalApiUrl,
      fetchImpl: input.fetchImpl
    }),
    'dlmm-active-bin-display-fallback': () => new FallbackDisplayValuationProvider()
  };
  const seen = new Set<ValuationProviderName>();
  const providers = (input.providerOrder?.length ? input.providerOrder : DEFAULT_PROVIDER_ORDER)
    .map((entry) => entry.trim())
    .map((entry) => entry === 'meteora-quote-only' ? 'meteora-dlmm-quote-only' : entry)
    .filter((entry): entry is ValuationProviderName => entry in factories)
    .filter((entry) => {
      if (seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    })
    .map((entry) => factories[entry]());

  return new ValuationProviderChain(providers, {
    cooldownMs: input.cooldownMs,
    negativeCacheTtlMs: input.negativeCacheTtlMs
  });
}
