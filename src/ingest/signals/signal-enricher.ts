import type {
  AuxiliarySignalProviderName,
  AuxiliarySignalsConfig
} from '../../config/schema.ts';
import { birdeyeSignalProvider } from './providers/birdeye.ts';
import { coingeckoSignalProvider } from './providers/coingecko.ts';
import { dexscreenerSignalProvider } from './providers/dexscreener.ts';
import { jupiterSignalProvider } from './providers/jupiter.ts';
import type {
  AuxiliarySignalCandidate,
  AuxiliarySignalEnricherOptions,
  AuxiliarySignalFields,
  AuxiliarySignalProvider,
  AuxiliarySignalProviderResult,
  AuxiliarySignalStatus
} from './types.ts';
import { EMPTY_AUXILIARY_SIGNAL_FIELDS } from './types.ts';

const DEFAULT_PROVIDERS: AuxiliarySignalProvider[] = [
  dexscreenerSignalProvider,
  jupiterSignalProvider,
  coingeckoSignalProvider,
  birdeyeSignalProvider
];

const aggregateCache = new Map<string, {
  expiresAt: number;
  fields: AuxiliarySignalFields;
}>();

export function clearAuxiliarySignalCacheForTests() {
  aggregateCache.clear();
}

export async function enrichCandidatesWithAuxiliarySignals<T extends AuxiliarySignalCandidate>(
  candidates: T[],
  options: AuxiliarySignalEnricherOptions
): Promise<Array<T & AuxiliarySignalFields>> {
  const config = options.config;
  const baseCandidates = candidates.map((candidate) => ({
    ...EMPTY_AUXILIARY_SIGNAL_FIELDS,
    ...candidate
  }));

  if (!config.enabled || config.mode !== 'rank-only') {
    return baseCandidates.map((candidate) => ({
      ...candidate,
      auxSignalStatus: 'disabled' as const
    }));
  }

  const activeProviders = resolveActiveProviders(config, options.providers ?? DEFAULT_PROVIDERS);
  if (activeProviders.length === 0) {
    return baseCandidates.map((candidate) => ({
      ...candidate,
      auxSignalStatus: 'disabled' as const
    }));
  }

  const nowMs = options.nowMs ?? Date.now();
  const cappedCount = Math.min(config.maxCandidatesPerCycle, baseCandidates.length);
  const enriched = [...baseCandidates];

  await Promise.all(
    enriched.slice(0, cappedCount).map(async (candidate, index) => {
      try {
        const fields = await resolveCandidateSignals(candidate, activeProviders, config, {
          ...options,
          nowMs
        });
        enriched[index] = {
          ...candidate,
          ...fields
        };
      } catch (error) {
        options.logger?.warn?.(
          `[Signals] Auxiliary signal enrichment failed open for ${candidate.mint}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  return enriched;
}

function resolveActiveProviders(
  config: AuxiliarySignalsConfig,
  providers: AuxiliarySignalProvider[]
) {
  const providerMap = new Map(providers.map((provider) => [provider.name, provider] as const));

  return config.providers
    .filter((providerName) => config.providerOptions[providerName]?.enabled ?? true)
    .map((providerName) => providerMap.get(providerName))
    .filter((provider): provider is AuxiliarySignalProvider => Boolean(provider));
}

async function resolveCandidateSignals(
  candidate: AuxiliarySignalCandidate,
  providers: AuxiliarySignalProvider[],
  config: AuxiliarySignalsConfig,
  options: AuxiliarySignalEnricherOptions & { nowMs: number }
) {
  const cacheKey = buildCacheKey(candidate, providers, config);
  const cached = aggregateCache.get(cacheKey);

  if (cached && options.nowMs < cached.expiresAt) {
    return cached.fields;
  }

  const results = await Promise.all(
    providers.map((provider) =>
      runProvider(provider, candidate, config, options)
    )
  );
  const fields = aggregateProviderResults(results, config);

  if (config.cacheTtlMs > 0) {
    aggregateCache.set(cacheKey, {
      expiresAt: options.nowMs + config.cacheTtlMs,
      fields
    });
  }

  return fields;
}

async function runProvider(
  provider: AuxiliarySignalProvider,
  candidate: AuxiliarySignalCandidate,
  config: AuxiliarySignalsConfig,
  options: AuxiliarySignalEnricherOptions
): Promise<AuxiliarySignalProviderResult> {
  const providerOptions = config.providerOptions[provider.name];
  const pending = provider.fetchSignal(candidate, {
    fetchImpl: options.fetchImpl,
    apiKey: resolveApiKey(provider.name, providerOptions?.apiKeyEnv),
    baseUrl: providerOptions?.baseUrl
  }).catch((error) => ({
    provider: provider.name,
    status: 'unavailable' as const,
    signalScore: 0,
    error: error instanceof Error ? error.message : String(error)
  }));

  return withTimeout(
    pending,
    config.timeoutMs,
    {
      provider: provider.name,
      status: 'timeout',
      signalScore: 0,
      error: 'timeout'
    }
  );
}

function resolveApiKey(
  providerName: AuxiliarySignalProviderName,
  configuredEnvName: string | undefined
) {
  const envName = configuredEnvName ?? DEFAULT_API_KEY_ENV_BY_PROVIDER[providerName];
  return envName ? process.env[envName] : undefined;
}

function aggregateProviderResults(
  results: AuxiliarySignalProviderResult[],
  config: AuxiliarySignalsConfig
): AuxiliarySignalFields {
  const weightedScore = results.reduce((sum, result) => {
    const weight = config.providerOptions[result.provider]?.weight ?? 1;
    return sum + Math.max(0, result.signalScore) * weight;
  }, 0);
  const availableCount = results.filter((result) => result.status === 'available').length;
  const timeoutCount = results.filter((result) => result.status === 'timeout').length;
  const auxSignalStatus = resolveAggregateStatus(results.length, availableCount, timeoutCount);

  return {
    auxSignalScore: Math.min(config.maxScoreBonus, weightedScore),
    dexscreenerBoostAmount: maxNumber(results, 'dexscreenerBoostAmount'),
    dexscreenerHasProfile: results.some((result) => result.dexscreenerHasProfile === true),
    jupiterOrganicScore: maxNumber(results, 'jupiterOrganicScore'),
    jupiterTrendingRank: minPositiveNumber(results, 'jupiterTrendingRank'),
    coingeckoTrendingRank: minPositiveNumber(results, 'coingeckoTrendingRank'),
    auxSignalStatus
  };
}

function resolveAggregateStatus(
  resultCount: number,
  availableCount: number,
  timeoutCount: number
): AuxiliarySignalStatus {
  if (resultCount === 0) {
    return 'disabled';
  }

  if (availableCount === resultCount) {
    return 'available';
  }

  if (availableCount > 0) {
    return 'partial';
  }

  return timeoutCount > 0 ? 'timeout' : 'unavailable';
}

function maxNumber(
  results: AuxiliarySignalProviderResult[],
  key: keyof AuxiliarySignalProviderResult
) {
  return results.reduce((max, result) => {
    const value = result[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(max, value)
      : max;
  }, 0);
}

function minPositiveNumber(
  results: AuxiliarySignalProviderResult[],
  key: keyof AuxiliarySignalProviderResult
) {
  const values = results
    .map((result) => result[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);

  return values.length > 0 ? Math.min(...values) : 0;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: T
): Promise<T> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(timeoutValue), timeoutMs);

    promise
      .then((value) => resolve(value))
      .catch(() => resolve(timeoutValue))
      .finally(() => clearTimeout(timeout));
  });
}

function buildCacheKey(
  candidate: AuxiliarySignalCandidate,
  providers: AuxiliarySignalProvider[],
  config: AuxiliarySignalsConfig
) {
  const providerKey = providers
    .map((provider) => `${provider.name}:${config.providerOptions[provider.name]?.weight ?? 1}`)
    .join(',');

  return [
    candidate.mint,
    candidate.symbol,
    candidate.chain ?? 'solana',
    candidate.address ?? candidate.poolAddress ?? '',
    providerKey,
    config.maxScoreBonus
  ].join('|');
}

const DEFAULT_API_KEY_ENV_BY_PROVIDER: Record<AuxiliarySignalProviderName, string | undefined> = {
  dexscreener: undefined,
  jupiter: 'JUPITER_API_KEY',
  coingecko: 'COINGECKO_API_KEY',
  birdeye: 'BIRDEYE_API_KEY'
};
