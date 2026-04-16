import { loadStrategyConfig } from '../config/loader.ts';
import { fetchGmgnTrader } from '../ingest/gmgn/client.ts';
import { normalizeGmgnTrader } from '../ingest/gmgn/normalize.ts';
import {
  fetchTokenSafetyBatch,
  DEFAULT_SAFETY_CONFIG,
  GMGN_SAFETY_DEFERRED_ERROR,
  type TokenSafetyConfig,
  type TokenSafetyResult
} from '../ingest/gmgn/token-safety-client.ts';
import { fetchMeteoraPools } from '../ingest/meteora/client.ts';
import { fetchPumpTrades } from '../ingest/pump/client.ts';
import { normalizePumpTokenEvent } from '../ingest/pump/normalize.ts';
import { SOURCE_ENDPOINTS } from '../ingest/shared/source-metadata.ts';
import { computeDynamicPositionSol } from '../risk/dynamic-position-sizing.ts';
import {
  applySafetyFilter,
  countActiveInventoryPositions,
  filterLpEligibleCandidates,
  type IngestCandidate,
  isInScanWindow,
  selectCandidate,
  type SafetyFilterDiagnostics
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

function resolveNestedString(payload: Record<string, unknown>, parentKeys: string[], childKeys: string[]) {
  for (const parentKey of parentKeys) {
    const nested = payload[parentKey];
    if (!isRecord(nested)) {
      continue;
    }

    const value = readString(nested, childKeys);
    if (value.length > 0) {
      return value;
    }
  }

  return '';
}

function resolveHasSolRoute(payload: Record<string, unknown>) {
  if (readBoolean(payload, ['hasSolRoute', 'has_sol_route'])) {
    return true;
  }

  const quoteMint = readString(payload, ['quoteMint', 'quote_mint', 'token_y_mint']);
  const quoteSymbol = readString(payload, ['quoteSymbol', 'quote_symbol', 'token_y_symbol']);
  const baseSymbol = readString(payload, ['baseSymbol', 'base_symbol', 'token_x_symbol']);
  const tokenYMint = resolveNestedString(payload, ['token_y', 'tokenY'], ['address', 'mint']);
  const tokenYSymbol = resolveNestedString(payload, ['token_y', 'tokenY'], ['symbol']);
  const tokenXSymbol = resolveNestedString(payload, ['token_x', 'tokenX'], ['symbol']);

  return quoteMint === SOL_MINT || quoteSymbol === 'SOL' || baseSymbol === 'SOL' || tokenYMint === SOL_MINT || tokenYSymbol === 'SOL' || tokenXSymbol === 'SOL';
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

  if (accountState.walletLpPositions?.some((position) => position.mint === mint && (position.hasLiquidity ?? true))) {
    return true;
  }

  if (accountState.journalLpPositions?.some((position) => position.mint === mint && (position.hasLiquidity ?? true))) {
    return true;
  }

  const walletPosition = accountState.walletTokens?.find((token) => token.mint === mint);

  if (accountState.walletTokens) {
    return (walletPosition?.amount ?? 0) > 0;
  }

  const journalPosition = accountState.journalTokens?.find((token) => token.mint === mint);
  return (journalPosition?.amount ?? 0) > 0;
}

function hasAccountLpPosition(accountState: LiveAccountState | undefined, mint: string) {
  if (!accountState || mint.length === 0) {
    return false;
  }

  return Boolean(
    accountState.walletLpPositions?.some((position) => position.mint === mint && (position.hasLiquidity ?? true)) ||
    accountState.journalLpPositions?.some((position) => position.mint === mint && (position.hasLiquidity ?? true))
  );
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

function resolveNoCandidateBlockReason(input: {
  prefilteredCount: number;
  postLpCount: number;
  postSafetyCount: number;
  eligibleSelectionCount: number;
  inScanWindow: boolean;
  activePositionsCount: number;
  safetyDiagnostics: SafetyFilterDiagnostics | null;
}) {
  if (input.prefilteredCount === 0) {
    return {
      blockReason: 'no-prefiltered-candidate',
      blockDetails: 'no pools passed ingest prefilter'
    };
  }

  if (input.postLpCount === 0) {
    return {
      blockReason: 'no-lp-eligible-candidate',
      blockDetails: 'prefiltered candidates failed LP thresholds'
    };
  }

  if (input.postSafetyCount === 0) {
    const diagnostics = input.safetyDiagnostics;
    const deferredChecks = diagnostics?.results.filter((result) => result.error === GMGN_SAFETY_DEFERRED_ERROR) ?? [];
    const scriptErrors = diagnostics?.results.filter((result) => result.error?.startsWith('script_error')) ?? [];
    const otherErrors = diagnostics?.results.filter((result) => result.error && !result.error.startsWith('script_error') && result.error !== GMGN_SAFETY_DEFERRED_ERROR) ?? [];

    if (deferredChecks.length > 0 && deferredChecks.length === (diagnostics?.results.length ?? 0)) {
      return {
        blockReason: 'gmgn-safety-deferred',
        blockDetails: input.inScanWindow
          ? 'uncached GMGN safety checks were deferred by batch throttling'
          : 'uncached GMGN safety checks were deferred because scan window is closed (maxBatchSize=0)'
      };
    }

    if (scriptErrors.length > 0 && scriptErrors.length === (diagnostics?.results.length ?? 0)) {
      return {
        blockReason: 'gmgn-safety-script-error',
        blockDetails: scriptErrors[0]?.error ?? 'gmgn safety subprocess failed'
      };
    }

    if (otherErrors.length > 0) {
      return {
        blockReason: 'gmgn-safety-check-failed',
        blockDetails: otherErrors[0]?.error ?? 'gmgn safety request failed'
      };
    }

    return {
      blockReason: 'no-safe-candidate',
      blockDetails: 'all LP-eligible candidates failed safety checks'
    };
  }

  return {
    blockReason: 'no-selected-candidate',
    blockDetails: 'candidates remained after filtering but none were selected'
  };
}

function buildFallbackContext(
  input: IngestContextBuilderInput,
  requestedPositionSol: number,
  sessionActive: boolean,
  slippageBps: number,
  traderSnapshot: ReturnType<typeof normalizeGmgnTrader> | null,
  diagnostics?: {
    blockReason?: string;
    blockDetails?: string;
  }
): IngestBackedCycleInput {
  const context: DecisionContextInput = {
    pool: {
      address: '',
      liquidityUsd: 0,
      hasSolRoute: false,
      candidateCount: 0,
      blockReason: diagnostics?.blockReason ?? '',
      blockDetails: diagnostics?.blockDetails ?? ''
    },
    token: {
      mint: '',
      symbol: '',
      liquidityUsd: 0,
      hasSolRoute: false,
      inSession: sessionActive,
      holders: 0,
      blockReason: diagnostics?.blockReason ?? ''
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
      token: '',
      blockReason: diagnostics?.blockReason ?? '',
      blockDetails: diagnostics?.blockDetails ?? ''
    }
  };

  return {
    context,
    requestedPositionSol,
    sessionPhase: sessionActive ? 'active' : 'closed'
  };
}

function isRecentPool(payload: Record<string, unknown>, now: Date, maxAgeMs: number) {
  const createdAt = readNumber(payload, ['created_at', 'createdAt', 'pool_created_at']);
  if (!createdAt) {
    return false;
  }

  return now.getTime() - createdAt <= maxAgeMs;
}

function buildCandidate(
  row: Record<string, unknown>,
  pumpIndexes: PumpIndexes,
  accountState: LiveAccountState | undefined
) {
  const payload = rawRecord(row);
  const mint = readString(payload, ['baseMint', 'base_mint', 'mint', 'token_x_mint']) || resolveNestedString(payload, ['token_x', 'tokenX'], ['address', 'mint']);
  const symbol = readString(payload, ['baseSymbol', 'base_symbol', 'symbol', 'token_x_symbol']) || resolveNestedString(payload, ['token_x', 'tokenX'], ['symbol']);
  const liquidityUsd = readNumber(payload, ['liquidityUsd', 'liquidity', 'tvl', 'tvlUsd']);
  const tokenEvent = mint.length > 0 ? pumpIndexes.tokenByMint.get(mint) : undefined;
  const holders = tokenEvent?.holders ?? readNumber(payload, ['holders']);

  const poolConfig = isRecord(payload.pool_config) ? payload.pool_config : {};
  const volumeObj = isRecord(payload.volume) ? payload.volume : {};
  const feeTvlObj = isRecord(payload.fee_tvl_ratio) ? payload.fee_tvl_ratio : {};

  return {
    address: readString(payload, ['address', 'poolAddress', 'pool_address']),
    mint,
    symbol: tokenEvent?.symbol || symbol,
    quoteMint: readString(payload, ['quoteMint', 'quote_mint', 'token_y_mint']) || resolveNestedString(payload, ['token_y', 'tokenY'], ['address', 'mint']),
    liquidityUsd,
    hasSolRoute: resolveHasSolRoute(payload),
    capturedAt: readString(payload, ['capturedAt', 'updatedAt', 'pool_created_at']),
    holders,
    hasInventory: hasAccountInventory(accountState, mint),
    hasLpPosition: hasAccountLpPosition(accountState, mint),
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
      pageSize: input.meteoraPageSize ?? 500,
      query: input.meteoraQuery,
      sortBy: input.meteoraSortBy ?? 'fee_tvl_ratio_24h:desc',
      filterBy: input.meteoraFilterBy ?? 'tvl>=1000 && is_blacklisted=false'
    }),
    maybeFetchPumpTradesRows(input),
    maybeFetchTraderSnapshot(input)
  ]);
  const pumpIndexes = buildPumpIndexes(pumpRows, input.traderWallet);
  const maxPoolAgeMs = 3 * 24 * 60 * 60 * 1000;
  const prefilteredRows = poolRows.filter((row) => {
    const payload = rawRecord(row);
    const poolConfig = isRecord(payload.pool_config) ? payload.pool_config : {};
    const isBlacklisted = readBoolean(payload, ['is_blacklisted', 'isBlacklisted']);
    const binStep = readNumber(poolConfig, ['bin_step', 'binStep']);
    const hasSolRoute = resolveHasSolRoute(payload);
    return hasSolRoute && !isBlacklisted && binStep >= 100 && isRecentPool(payload, now, maxPoolAgeMs);
  });

  let candidates = prefilteredRows.map((row) =>
    buildCandidate(
      row,
      pumpIndexes,
      input.accountState
    )
  );
  const preLpCount = candidates.length;
  candidates = filterLpEligibleCandidates(candidates, config);
  const postLpCount = candidates.length;
  const activePositionsCount = countActiveInventoryPositions(input.accountState);
  const inScanWindow = isInScanWindow(now);
  const maxBatchSize = 50;
  const safetyConfig = input.safetyFilterConfig ?? DEFAULT_SAFETY_CONFIG;
  let safetyDiagnostics: SafetyFilterDiagnostics | null = null;
  candidates = await applySafetyFilter(candidates, {
    safetyConfig,
    maxBatchSize,
    fetchSafety: async (mints) =>
      (input.fetchTokenSafetyBatchImpl ?? defaultFetchSafetyBatch(maxBatchSize))(mints),
    logger: console,
    onDiagnostics: (diagnostics) => {
      safetyDiagnostics = diagnostics;
    }
  });
  const postSafetyCount = candidates.length;

  console.log(`[Ingest] pools=${poolRows.length} prefilter=${prefilteredRows.length} lp=${preLpCount}->${postLpCount} safety=${postSafetyCount} scanWindow=${inScanWindow} activePositions=${activePositionsCount}`);

  const candidate = selectCandidate(candidates, input.strategy, activePositionsCount);
  const eligibleSelectionCount = candidates.filter((item) => item.hasInventory || activePositionsCount < 5).length;

  if (!candidate) {
    console.log(`[Ingest] No candidate selected: candidates=${candidates.length} eligibleForSelection=${eligibleSelectionCount}`);
  }

  if (!candidate) {
    const diagnostics = resolveNoCandidateBlockReason({
      prefilteredCount: prefilteredRows.length,
      postLpCount,
      postSafetyCount,
      eligibleSelectionCount,
      inScanWindow,
      activePositionsCount,
      safetyDiagnostics
    });

    console.log(`[Ingest] Blocking live cycle: ${diagnostics.blockReason}${diagnostics.blockDetails ? ` (${diagnostics.blockDetails})` : ''}`);

    return buildFallbackContext(
      input,
      input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol),
      sessionActive,
      config.solRouteLimits.maxSlippageBps,
      traderSnapshot,
      diagnostics
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
      expectedOutSol: requestedPositionSol,
      capturedAt: candidate.capturedAt
    },
    trader: {
      wallet: input.traderWallet ?? '',
      hasInventory: candidate.hasInventory,
      hasLpPosition: candidate.hasLpPosition,
      labels: traderSnapshot?.labels ?? [],
      pnlUsd: traderSnapshot?.pnlUsd ?? 0,
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
