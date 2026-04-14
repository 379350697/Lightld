import { loadStrategyConfig } from '../config/loader.ts';
import { fetchGmgnTrader } from '../ingest/gmgn/client.ts';
import { normalizeGmgnTrader } from '../ingest/gmgn/normalize.ts';
import {
  fetchTokenSafetyBatch,
  DEFAULT_SAFETY_CONFIG,
  type TokenSafetyConfig,
  type TokenSafetyResult
} from '../ingest/gmgn/token-safety-client.ts';
import { fetchMeteoraPools } from '../ingest/meteora/client.ts';
import { fetchPumpTrades } from '../ingest/pump/client.ts';
import { normalizePumpTokenEvent } from '../ingest/pump/normalize.ts';
import { SOURCE_ENDPOINTS } from '../ingest/shared/source-metadata.ts';
import { computeWeightedScore } from '../strategy/filtering/scoring.ts';
import { computeDynamicPositionSol } from '../risk/dynamic-position-sizing.ts';
import {
  applySafetyFilter,
  countActiveInventoryPositions,
  filterLpEligibleCandidates,
  type IngestCandidate,
  isInScanWindow,
  selectCandidate
} from './ingest-candidate-selection.ts';
import type { DecisionContextInput } from './build-decision-context.ts';
import type { LiveAccountState } from './live-account-provider.ts';
import type { LiveCycleInput, StrategyId } from './live-cycle.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STRATEGY_CONFIGS = {
  'new-token-v1': 'src/config/strategies/new-token-v1.yaml',
  'large-pool-v1': 'src/config/strategies/large-pool-v1.yaml'
} as const;

type FetchMeteoraPoolsImpl = (
  options?: Parameters<typeof fetchMeteoraPools>[0]
) => Promise<Record<string, unknown>[]>;
type FetchPumpTradesImpl = (
  options?: Parameters<typeof fetchPumpTrades>[0]
) => Promise<Record<string, unknown>[]>;
type FetchGmgnTraderImpl = (
  wallet: string,
  options?: Parameters<typeof fetchGmgnTrader>[1]
) => Promise<Record<string, unknown>>;
type FetchTokenSafetyBatchImpl = (mints: string[]) => Promise<TokenSafetyResult[]>;

export type IngestBackedCycleInput = Omit<LiveCycleInput, 'strategy'> & {
  context: DecisionContextInput;
  requestedPositionSol: number;
  sessionPhase: 'active' | 'closed';
};

type IngestContextBuilderInput = {
  strategy: StrategyId;
  traderWallet?: string;
  requestedPositionSol?: number;
  accountState?: LiveAccountState;
  now?: Date;
  meteoraPageSize?: number;
  meteoraQuery?: string;
  meteoraSortBy?: string;
  meteoraFilterBy?: string;
  safetyFilterConfig?: TokenSafetyConfig;
  fetchMeteoraPoolsImpl?: FetchMeteoraPoolsImpl;
  fetchPumpTradesImpl?: FetchPumpTradesImpl;
  fetchGmgnTraderImpl?: FetchGmgnTraderImpl;
  fetchTokenSafetyBatchImpl?: FetchTokenSafetyBatchImpl;
};

type PumpIndexes = {
  tokenByMint: Map<string, ReturnType<typeof normalizePumpTokenEvent>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawRecord(value: Record<string, unknown>) {
  const raw = value.raw;
  return isRecord(raw) ? raw : value;
}

function readString(
  payload: Record<string, unknown>,
  keys: string[]
) {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return '';
}

function readNumber(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}

function readBoolean(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      if (value === 'true') {
        return true;
      }

      if (value === 'false') {
        return false;
      }
    }
  }

  return false;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number) {
  return Number(value.toFixed(2));
}

function normalizeRatio(value: number, threshold: number) {
  if (threshold <= 0) {
    return 0;
  }

  return clamp((value / threshold) * 100, 0, 100);
}

function parseMinutes(value: string) {
  const [hours, minutes] = value.split(':').map((part) => Number(part));

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return 0;
  }

  return hours * 60 + minutes;
}

function isWithinSessionWindows(
  windows: Array<{ start: string; end: string }>,
  now: Date
) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return windows.some((window) => {
    const startMinutes = parseMinutes(window.start);
    const endMinutes = parseMinutes(window.end);

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }

    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  });
}

function resolveHasSolRoute(payload: Record<string, unknown>) {
  if (readBoolean(payload, ['hasSolRoute', 'has_sol_route'])) {
    return true;
  }

  const quoteMint = readString(payload, ['quoteMint', 'quote_mint', 'token_y_mint']);
  const quoteSymbol = readString(payload, ['quoteSymbol', 'quote_symbol', 'token_y_symbol']);
  const baseSymbol = readString(payload, ['baseSymbol', 'base_symbol', 'token_x_symbol']);

  return quoteMint === SOL_MINT || quoteSymbol === 'SOL' || baseSymbol === 'SOL';
}

function resolveMomentum(
  payload: Record<string, unknown>,
  liquidityUsd: number,
  tokenEvent: ReturnType<typeof normalizePumpTokenEvent> | undefined,
  now: Date
) {
  const explicitMomentum = readNumber(payload, ['momentum']);

  if (explicitMomentum > 0) {
    return clamp(explicitMomentum, 0, 100);
  }

  const recentVolume = [
    readNumber(payload, ['volume_5m', 'volume5m']),
    readNumber(payload, ['volume_30m', 'volume30m']),
    readNumber(payload, ['volume_1h', 'volume1h']),
    readNumber(payload, ['volume_24h', 'volume24h'])
  ].find((value) => value > 0) ?? 0;

  if (recentVolume > 0 && liquidityUsd > 0) {
    return clamp((recentVolume / liquidityUsd) * 100, 0, 100);
  }

  if (tokenEvent) {
    const ageMs = Math.max(0, now.getTime() - Date.parse(tokenEvent.capturedAt));

    return clamp(100 - ageMs / 60_000, 0, 100);
  }

  return 0;
}

function buildPumpIndexes(
  rows: Record<string, unknown>[],
  _traderWallet: string | undefined
): PumpIndexes {
  const tokenByMint = new Map<string, ReturnType<typeof normalizePumpTokenEvent>>();

  for (const row of rows) {
    const payload = rawRecord(row);
    const wallet = readString(payload, ['wallet']);
    const mint = readString(payload, ['mint', 'baseMint', 'base_mint']);

    if (wallet.length > 0) {
      continue;
    }

    const tokenEvent = normalizePumpTokenEvent({
      mint,
      symbol: readString(payload, ['symbol', 'baseSymbol', 'base_symbol']),
      holders: readNumber(payload, ['holders']),
      timestamp: readString(payload, ['timestamp', 'capturedAt', 'updatedAt']),
      raw: payload
    });

    if (tokenEvent.mint.length === 0) {
      continue;
    }

    const existing = tokenByMint.get(tokenEvent.mint);

    if (!existing || Date.parse(tokenEvent.capturedAt) >= Date.parse(existing.capturedAt)) {
      tokenByMint.set(tokenEvent.mint, tokenEvent);
    }
  }

  return {
    tokenByMint
  };
}

function hasAccountInventory(accountState: LiveAccountState | undefined, mint: string) {
  if (!accountState || mint.length === 0) {
    return false;
  }

  const walletPosition = accountState.walletTokens?.find((token) => token.mint === mint);

  if (accountState.walletTokens) {
    return (walletPosition?.amount ?? 0) > 0;
  }

  const journalPosition = accountState.journalTokens?.find((token) => token.mint === mint);
  return (journalPosition?.amount ?? 0) > 0;
}

function isPlaceholderEndpoint(url: string) {
  return url.includes('example.invalid');
}

async function maybeFetchPumpTradesRows(input: IngestContextBuilderInput) {
  if (input.fetchPumpTradesImpl) {
    return input.fetchPumpTradesImpl();
  }

  if (isPlaceholderEndpoint(SOURCE_ENDPOINTS.pumpTrades)) {
    return [];
  }

  try {
    return await fetchPumpTrades();
  } catch {
    return [];
  }
}

async function maybeFetchTraderSnapshot(input: IngestContextBuilderInput) {
  if (!input.traderWallet) {
    return null;
  }

  if (input.fetchGmgnTraderImpl) {
    return normalizeGmgnTrader(await input.fetchGmgnTraderImpl(input.traderWallet));
  }

  if (isPlaceholderEndpoint(SOURCE_ENDPOINTS.gmgnTraderBase)) {
    return null;
  }

  try {
    return normalizeGmgnTrader(await fetchGmgnTrader(input.traderWallet));
  } catch {
    return null;
  }
}

function defaultRequestedPositionSol(maxLivePositionSol: number) {
  return Math.min(0.1, maxLivePositionSol);
}

function buildFallbackContext(
  input: IngestContextBuilderInput,
  requestedPositionSol: number,
  sessionActive: boolean,
  slippageBps: number,
  traderSnapshot: ReturnType<typeof normalizeGmgnTrader> | null
): IngestBackedCycleInput {
  const context: DecisionContextInput = {
    pool: {
      address: '',
      liquidityUsd: 0,
      hasSolRoute: false,
      score: 0,
      candidateCount: 0
    },
    token: {
      mint: '',
      symbol: '',
      liquidityUsd: 0,
      hasSolRoute: false,
      inSession: sessionActive,
      score: 0,
      holders: 0
    },
    trader: {
      wallet: input.traderWallet ?? '',
      hasInventory: false,
      labels: traderSnapshot?.labels ?? [],
      pnlUsd: traderSnapshot?.pnlUsd ?? 0
    },
    route: {
      hasSolRoute: false,
      expectedOutSol: requestedPositionSol,
      slippageBps,
      poolAddress: '',
      token: ''
    }
  };

  return {
    context,
    requestedPositionSol,
    sessionPhase: sessionActive ? 'active' : 'closed'
  };
}

function buildCandidate(
  row: Record<string, unknown>,
  pumpIndexes: PumpIndexes,
  accountState: LiveAccountState | undefined,
  now: Date,
  minHolders: number,
  minLiquidityUsd: number,
  scoringWeights: { holders: number; liquidity: number; momentum: number }
) {
  const payload = rawRecord(row);
  const mint = readString(payload, ['baseMint', 'base_mint', 'mint', 'token_x_mint']);
  const symbol = readString(payload, ['baseSymbol', 'base_symbol', 'symbol', 'token_x_symbol']);
  const liquidityUsd = readNumber(payload, ['liquidityUsd', 'liquidity', 'tvl', 'tvlUsd']);
  const tokenEvent = mint.length > 0 ? pumpIndexes.tokenByMint.get(mint) : undefined;
  const holders = tokenEvent?.holders ?? readNumber(payload, ['holders']);
  const momentum = resolveMomentum(payload, liquidityUsd, tokenEvent, now);
  const holdersScore = normalizeRatio(holders, minHolders);
  const liquidityScore = normalizeRatio(liquidityUsd, minLiquidityUsd);
  const score = roundScore(
    computeWeightedScore(
      {
        holders: holdersScore,
        liquidity: liquidityScore,
        momentum
      },
      scoringWeights
    )
  );

  const poolConfig = isRecord(payload.pool_config) ? payload.pool_config : {};
  const volumeObj = isRecord(payload.volume) ? payload.volume : {};
  const feeTvlObj = isRecord(payload.fee_tvl_ratio) ? payload.fee_tvl_ratio : {};

  return {
    address: readString(payload, ['address', 'poolAddress', 'pool_address']),
    mint,
    symbol: tokenEvent?.symbol || symbol,
    quoteMint: readString(payload, ['quoteMint', 'quote_mint', 'token_y_mint']),
    liquidityUsd,
    hasSolRoute: resolveHasSolRoute(payload),
    capturedAt: readString(payload, ['capturedAt', 'updatedAt', 'pool_created_at']),
    holders,
    momentum,
    hasInventory: hasAccountInventory(accountState, mint),
    score,
    binStep: readNumber(poolConfig, ['bin_step', 'binStep']),
    baseFeePct: readNumber(poolConfig, ['base_fee_pct', 'baseFeePct']),
    volume24h: readNumber(volumeObj, ['24h']),
    feeTvlRatio24h: readNumber(feeTvlObj, ['24h'])
  } satisfies IngestCandidate;
}

export async function buildLiveCycleInputFromIngest(
  input: IngestContextBuilderInput
): Promise<IngestBackedCycleInput> {
  const now = input.now ?? new Date();
  const config = await loadStrategyConfig(STRATEGY_CONFIGS[input.strategy]);
  const sessionActive = isWithinSessionWindows(config.sessionWindows, now);
  const [poolRows, pumpRows, traderSnapshot] = await Promise.all([
    (input.fetchMeteoraPoolsImpl ?? fetchMeteoraPools)({
      pageSize: input.meteoraPageSize ?? 50,
      query: input.meteoraQuery,
      sortBy: input.meteoraSortBy ?? 'fee_tvl_ratio_24h:desc',
      filterBy: input.meteoraFilterBy ?? 'tvl>=10000 && is_blacklisted=false'
    }),
    maybeFetchPumpTradesRows(input),
    maybeFetchTraderSnapshot(input)
  ]);
  const pumpIndexes = buildPumpIndexes(pumpRows, input.traderWallet);
  let candidates = poolRows.map((row) =>
    buildCandidate(
      row,
      pumpIndexes,
      input.accountState,
      now,
      config.filters.minHolders,
      config.filters.minLiquidityUsd,
      config.scoringWeights
    )
  );
  candidates = filterLpEligibleCandidates(candidates, config);
  const activePositionsCount = countActiveInventoryPositions(input.accountState);
  const inScanWindow = isInScanWindow(now);
  const maxBatchSize = inScanWindow ? 50 : 0;
  const safetyConfig = input.safetyFilterConfig ?? DEFAULT_SAFETY_CONFIG;
  candidates = await applySafetyFilter(candidates, {
    safetyConfig,
    maxBatchSize,
    fetchSafety: async (mints) =>
      (input.fetchTokenSafetyBatchImpl ?? defaultFetchSafetyBatch(maxBatchSize))(mints),
    logger: console
  });

  const candidate = selectCandidate(candidates, input.strategy, inScanWindow, activePositionsCount);

  if (!candidate) {
    return buildFallbackContext(
      input,
      input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol),
      sessionActive,
      config.solRouteLimits.maxSlippageBps,
      traderSnapshot
    );
  }

  const requestedPositionSol = computeDynamicPositionSol(
    candidate.liquidityUsd,
    input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol)
  );

  const context: DecisionContextInput = {
    pool: {
      address: candidate.address,
      liquidityUsd: candidate.liquidityUsd,
      hasSolRoute: candidate.hasSolRoute,
      score: candidate.score,
      capturedAt: candidate.capturedAt,
      candidateCount: candidates.length,
      binStep: candidate.binStep,
      baseFeePct: candidate.baseFeePct,
      volume24h: candidate.volume24h,
      feeTvlRatio24h: candidate.feeTvlRatio24h
    },
    token: {
      mint: candidate.mint,
      symbol: candidate.symbol,
      liquidityUsd: candidate.liquidityUsd,
      hasSolRoute: candidate.hasSolRoute,
      inSession: sessionActive,
      holders: candidate.holders,
      score: candidate.score,
      expectedOutSol: requestedPositionSol,
      capturedAt: candidate.capturedAt
    },
    trader: {
      wallet: input.traderWallet ?? '',
      hasInventory: candidate.hasInventory,
      labels: traderSnapshot?.labels ?? [],
      pnlUsd: traderSnapshot?.pnlUsd ?? 0,
      score: traderSnapshot ? clamp(traderSnapshot.pnlUsd / 10, 0, 100) : 0,
      freshnessMs: traderSnapshot?.freshnessMs ?? 0
    },
    route: {
      hasSolRoute: candidate.hasSolRoute,
      expectedOutSol: requestedPositionSol,
      slippageBps: config.solRouteLimits.maxSlippageBps,
      token: candidate.symbol,
      poolAddress: candidate.address
    }
  };

  return {
    context,
    requestedPositionSol,
    sessionPhase: sessionActive ? 'active' : 'closed'
  };
}

function defaultFetchSafetyBatch(maxBatchSize: number) {
  return async (mints: string[]) =>
    fetchTokenSafetyBatch(mints, { maxBatchSize, timeoutMs: 15 * 60_000 });
}
