export type RpcEndpointKind = 'solana-read' | 'solana-write' | 'dlmm' | 'jupiter';

export type RpcEndpointRegistryOptions = {
  rateLimitedCooldownMs?: number;
  timeoutCooldownMs?: number;
  serverErrorCooldownMs?: number;
  maxWaitMs?: number;
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
};

export type RpcEndpointStateSnapshot = {
  url: string;
  kinds: RpcEndpointKind[];
  maxConcurrency: number;
  inFlight: number;
  cooldownUntil: string;
  consecutiveFailures: number;
  lastFailureReason: string;
  lastSuccessAt: string;
};

type RpcEndpointState = {
  url: string;
  kinds: Set<RpcEndpointKind>;
  maxConcurrency: number;
  inFlight: number;
  cooldownUntil: number;
  consecutiveFailures: number;
  lastFailureReason: string;
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
  timeoutCooldownMs: 10_000,
  serverErrorCooldownMs: 5_000,
  maxWaitMs: 1_000
} satisfies Required<RpcEndpointRegistryOptions>;

const MAX_RATE_LIMIT_COOLDOWN_MULTIPLIER = 4;

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

function extractStatus(error: Error) {
  const directStatus = (error as Error & { status?: unknown }).status;
  if (typeof directStatus === 'number') {
    return directStatus;
  }

  const match = error.message.match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
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
  const merged = { ...DEFAULT_OPTIONS, ...options };

  if (
    status === 429 ||
    /(^|[^0-9])429([^0-9]|$)|too many requests|rate.?limit/i.test(normalized.message)
  ) {
    return {
      retryable: true,
      reason: 'rate-limited',
      cooldownMs: merged.rateLimitedCooldownMs
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
    this.options = { ...DEFAULT_OPTIONS, ...options };
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
      consecutiveFailures: 0,
      lastFailureReason: '',
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
        consecutiveFailures: state.consecutiveFailures,
        lastFailureReason: state.lastFailureReason,
        lastSuccessAt: toIso(state.lastSuccessAt)
      }));
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

        if (state.inFlight >= state.maxConcurrency) {
          earliestReadyAt = Math.min(earliestReadyAt, now + 25);
          continue;
        }

        state.inFlight += 1;
        try {
          const result = await options.execute(url);
          const recovered = state.consecutiveFailures > 0 || state.lastFailureReason.length > 0 || state.cooldownUntil > 0;
          state.consecutiveFailures = 0;
          state.lastFailureReason = '';
          state.cooldownUntil = 0;
          state.lastSuccessAt = Date.now();

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
          const cooldownMs = disposition.reason === 'rate-limited'
            ? scaleRateLimitCooldown(disposition.cooldownMs ?? 0, state.consecutiveFailures)
            : (disposition.cooldownMs ?? 0);
          state.lastFailureReason = disposition.reason;
          state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + cooldownMs);
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
