export type RpcEndpointKind = 'solana-read' | 'solana-write' | 'dlmm' | 'jupiter';

export type RpcEndpointRegistryOptions = {
  rateLimitedCooldownMs?: number;
  rateLimitFailureDecayMs?: number;
  timeoutCooldownMs?: number;
  serverErrorCooldownMs?: number;
  maxWaitMs?: number;
  minRequestIntervalMs?: number;
};

export type RpcEndpointRegistration = {
  url: string;
  kind: RpcEndpointKind;
  maxConcurrency: number;
};

export type RpcEndpointErrorDisposition = {
  retryable: boolean;
  reason: string;
  cooldownMs?: number;
  retryAfterMs?: number;
};

export type RpcEndpointStateSnapshot = {
  url: string;
  kinds: RpcEndpointKind[];
  maxConcurrency: number;
  inFlight: number;
  cooldownUntil: string;
  nextRequestAt: string;
  consecutiveFailures: number;
  rateLimitStrikes: number;
  lastFailureReason: string;
  lastRateLimitedAt: string;
  lastSuccessAt: string;
};

type RpcEndpointState = {
  url: string;
  kinds: Set<RpcEndpointKind>;
  maxConcurrency: number;
  inFlight: number;
  cooldownUntil: number;
  nextRequestAt: number;
  consecutiveFailures: number;
  rateLimitStrikes: number;
  lastFailureReason: string;
  lastRateLimitedAt: number;
  lastSuccessAt: number;
};

type RunWithEndpointOptions<T> = {
  kind: RpcEndpointKind;
  candidates: string[];
  execute: (url: string) => Promise<T>;
  classifyError: (error: unknown) => RpcEndpointErrorDisposition | null;
  maxWaitMs?: number;
};

const DEFAULT_OPTIONS = {
  rateLimitedCooldownMs: 30_000,
  rateLimitFailureDecayMs: 10 * 60_000,
  timeoutCooldownMs: 10_000,
  serverErrorCooldownMs: 5_000,
  maxWaitMs: 1_000,
  minRequestIntervalMs: 0
} satisfies Required<RpcEndpointRegistryOptions>;

const MAX_RATE_LIMIT_COOLDOWN_MULTIPLIER = 8;

function sleep(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function formatEndpointHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function toIso(timestamp: number) {
  return timestamp > 0 ? new Date(timestamp).toISOString() : '';
}

function scaleRateLimitCooldown(baseCooldownMs: number, consecutiveFailures: number) {
  const multiplier = Math.min(
    MAX_RATE_LIMIT_COOLDOWN_MULTIPLIER,
    Math.max(1, consecutiveFailures)
  );

  return baseCooldownMs * multiplier;
}

function isServerErrorReason(reason: string) {
  return /^http-5\d\d$/.test(reason);
}

function extractStatus(error: Error) {
  const directStatus = (error as Error & { status?: unknown }).status;
  if (typeof directStatus === 'number') {
    return directStatus;
  }

  const match = error.message.match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function extractRetryAfterMs(error: Error) {
  const retryAfterMs = (error as Error & { retryAfterMs?: unknown }).retryAfterMs;
  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : undefined;
}

export class NoRpcEndpointAvailableError extends Error {
  readonly kind: RpcEndpointKind;
  readonly snapshots: RpcEndpointStateSnapshot[];

  constructor(kind: RpcEndpointKind, snapshots: RpcEndpointStateSnapshot[], cause?: unknown) {
    super(`No RPC endpoint available for ${kind}`);
    this.name = 'NoRpcEndpointAvailableError';
    this.kind = kind;
    this.snapshots = snapshots;

    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function classifyRetryableRpcError(
  error: unknown,
  options: RpcEndpointRegistryOptions = {}
): RpcEndpointErrorDisposition | null {
  const normalized = toError(error);
  const status = extractStatus(normalized);
  const retryAfterMs = extractRetryAfterMs(normalized);
  const merged = { ...DEFAULT_OPTIONS, ...options };

  if (
    status === 429 ||
    /(^|[^0-9])429([^0-9]|$)|too many requests|rate.?limit/i.test(normalized.message)
  ) {
    return {
      retryable: true,
      reason: 'rate-limited',
      cooldownMs: Math.max(merged.rateLimitedCooldownMs, retryAfterMs ?? 0),
      retryAfterMs
    };
  }

  if (/timeout/i.test(normalized.message) || normalized.name === 'AbortError') {
    return {
      retryable: true,
      reason: 'timeout',
      cooldownMs: merged.timeoutCooldownMs
    };
  }

  if ((status ?? 0) >= 500) {
    return {
      retryable: true,
      reason: `http-${status}`,
      cooldownMs: merged.serverErrorCooldownMs
    };
  }

  return null;
}

export class RpcEndpointRegistry {
  private readonly states = new Map<string, RpcEndpointState>();
  private readonly options: Required<RpcEndpointRegistryOptions>;

  constructor(options: RpcEndpointRegistryOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      minRequestIntervalMs: Math.max(0, options.minRequestIntervalMs ?? DEFAULT_OPTIONS.minRequestIntervalMs)
    };
  }

  register(registration: RpcEndpointRegistration) {
    const existing = this.states.get(registration.url);
    if (existing) {
      existing.kinds.add(registration.kind);
      existing.maxConcurrency = Math.min(existing.maxConcurrency, registration.maxConcurrency);
      return;
    }

    this.states.set(registration.url, {
      url: registration.url,
      kinds: new Set([registration.kind]),
      maxConcurrency: registration.maxConcurrency,
      inFlight: 0,
      cooldownUntil: 0,
      nextRequestAt: 0,
      consecutiveFailures: 0,
      rateLimitStrikes: 0,
      lastFailureReason: '',
      lastRateLimitedAt: 0,
      lastSuccessAt: 0
    });
  }

  registerMany(registrations: RpcEndpointRegistration[]) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  snapshots(candidates?: string[]) {
    const urls = candidates ?? [...this.states.keys()];
    return urls
      .map((url) => this.states.get(url))
      .filter((state): state is RpcEndpointState => Boolean(state))
      .map((state) => ({
        url: state.url,
        kinds: [...state.kinds],
        maxConcurrency: state.maxConcurrency,
        inFlight: state.inFlight,
        cooldownUntil: toIso(state.cooldownUntil),
        nextRequestAt: toIso(state.nextRequestAt),
        consecutiveFailures: state.consecutiveFailures,
        rateLimitStrikes: state.rateLimitStrikes,
        lastFailureReason: state.lastFailureReason,
        lastRateLimitedAt: toIso(state.lastRateLimitedAt),
        lastSuccessAt: toIso(state.lastSuccessAt)
      }));
  }

  private resolveCooldownMs(disposition: RpcEndpointErrorDisposition, state: RpcEndpointState) {
    if (disposition.reason === 'rate-limited') {
      return Math.max(
        scaleRateLimitCooldown(this.options.rateLimitedCooldownMs, state.rateLimitStrikes),
        disposition.cooldownMs ?? 0,
        disposition.retryAfterMs ?? 0
      );
    }

    if (disposition.reason === 'timeout') {
      return Math.max(this.options.timeoutCooldownMs, disposition.cooldownMs ?? 0);
    }

    if (isServerErrorReason(disposition.reason)) {
      return Math.max(this.options.serverErrorCooldownMs, disposition.cooldownMs ?? 0);
    }

    return disposition.cooldownMs ?? 0;
  }

  async runWithEndpoint<T>(options: RunWithEndpointOptions<T>): Promise<T> {
    const candidates = options.candidates.filter(Boolean);
    let lastError: Error | undefined;
    const deadline = Date.now() + (options.maxWaitMs ?? this.options.maxWaitMs);

    if (candidates.length === 0) {
      throw new NoRpcEndpointAvailableError(options.kind, []);
    }

    while (true) {
      const now = Date.now();
      let earliestReadyAt = Number.POSITIVE_INFINITY;

      for (const url of candidates) {
        const state = this.states.get(url);
        if (!state) {
          continue;
        }

        if (state.cooldownUntil > now) {
          earliestReadyAt = Math.min(earliestReadyAt, state.cooldownUntil);
          continue;
        }

        if (state.nextRequestAt > now) {
          earliestReadyAt = Math.min(earliestReadyAt, state.nextRequestAt);
          continue;
        }

        if (state.inFlight >= state.maxConcurrency) {
          earliestReadyAt = Math.min(earliestReadyAt, now + 25);
          continue;
        }

        const startedAt = Date.now();
        state.nextRequestAt = Math.max(
          state.nextRequestAt,
          startedAt + this.options.minRequestIntervalMs
        );
        state.inFlight += 1;
        try {
          const result = await options.execute(url);
          const recovered = state.consecutiveFailures > 0 || state.lastFailureReason.length > 0 || state.cooldownUntil > 0;
          state.consecutiveFailures = 0;
          state.lastFailureReason = '';
          state.cooldownUntil = 0;
          state.lastSuccessAt = Date.now();
          if (
            state.lastRateLimitedAt > 0 &&
            state.lastSuccessAt - state.lastRateLimitedAt > this.options.rateLimitFailureDecayMs
          ) {
            state.rateLimitStrikes = 0;
            state.lastRateLimitedAt = 0;
          }

          if (recovered) {
            console.info(
              `[RpcEndpointRegistry] endpoint recovered kind=${options.kind} host=${formatEndpointHost(url)}`
            );
          }

          return result;
        } catch (error) {
          const disposition = options.classifyError(error);
          if (!disposition || !disposition.retryable) {
            throw error;
          }

          state.consecutiveFailures += 1;
          const failureAt = Date.now();
          if (disposition.reason === 'rate-limited') {
            if (
              state.lastRateLimitedAt > 0 &&
              failureAt - state.lastRateLimitedAt > this.options.rateLimitFailureDecayMs
            ) {
              state.rateLimitStrikes = 0;
            }
            state.rateLimitStrikes += 1;
            state.lastRateLimitedAt = failureAt;
          }
          const cooldownMs = this.resolveCooldownMs(disposition, state);
          state.lastFailureReason = disposition.reason;
          state.cooldownUntil = Math.max(state.cooldownUntil, failureAt + cooldownMs);
          lastError = toError(error);

          console.warn(
            `[RpcEndpointRegistry] endpoint cooling down kind=${options.kind} host=${formatEndpointHost(url)} reason=${disposition.reason} failures=${state.consecutiveFailures} cooldownMs=${cooldownMs}`
          );
        } finally {
          state.inFlight = Math.max(0, state.inFlight - 1);
        }
      }

      const waitUntil = Math.min(earliestReadyAt, deadline);
      if (!Number.isFinite(waitUntil) || waitUntil <= Date.now()) {
        const snapshots = this.snapshots(candidates);
        console.error(
          `[RpcEndpointRegistry] no endpoint available kind=${options.kind} states=${JSON.stringify(snapshots)}`
        );
        throw new NoRpcEndpointAvailableError(options.kind, snapshots, lastError);
      }

      await sleep(Math.max(1, waitUntil - Date.now()));
    }
  }
}
