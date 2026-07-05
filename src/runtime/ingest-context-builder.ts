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
import { enrichCandidatesWithAuxiliarySignals } from '../ingest/signals/signal-enricher.ts';
import {
  EMPTY_AUXILIARY_SIGNAL_FIELDS,
  type AuxiliarySignalEnricherOptions
} from '../ingest/signals/types.ts';
import { computeDynamicPositionSol } from '../risk/dynamic-position-sizing.ts';
import type { CandidateScanRecord, CandidateSampleRecord } from '../evolution/index.ts';
import { isAllowedMeteoraEntryBinStep } from '../candidate-pool/meteora-candidate-builder.ts';
import type { CandidatePoolEntry, CandidatePoolReader } from '../candidate-pool/types.ts';
import {
  applySafetyFilter,
  filterRecentlyClosedMintCandidates,
  countActiveInventoryPositions,
  filterLpEligibleCandidates,
  type IngestCandidate,
  isInScanWindow,
  rankCandidatesForSafety,
  selectCandidate,
  type SafetyFilterDiagnostics,
  RECENTLY_CLOSED_MINT_REOPEN_COOLDOWN_MS
} from './ingest-candidate-selection.ts';
import type { DecisionContextInput } from './build-decision-context.ts';
import type { LiveAccountState } from './live-account-provider.ts';
import type { PositionStateSnapshot, TargetOpenCooldownSnapshot } from './state-types.ts';
import type { LiveCycleInput, StrategyId } from './live-cycle.ts';
import { resolvePositionBusinessSemantics } from './position-business-semantics.ts';

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
type EnrichAuxiliarySignalsImpl = (
  candidates: IngestCandidate[],
  options: AuxiliarySignalEnricherOptions
) => Promise<IngestCandidate[]>;

export type IngestBackedCycleInput = Omit<LiveCycleInput, 'strategy'> & {
  context: DecisionContextInput;
  requestedPositionSol: number;
  sessionPhase: 'active' | 'closed';
};

export type IngestSelectionMode = 'default' | 'maintenance-only' | 'new-open-only';

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
  enrichAuxiliarySignalsImpl?: EnrichAuxiliarySignalsImpl;
  candidateScanSink?: {
    appendScan(scan: CandidateScanRecord): Promise<void>;
  };
  newCandidateSafetyMaxBatchSize?: number;
  newCandidateSafetyTimeoutMs?: number;
  maxActivePositions?: number;
  positionState?: PositionStateSnapshot;
  candidatePoolReader?: CandidatePoolReader;
  candidatePoolReadEnabled?: boolean;
  candidatePoolMaxAgeMs?: number;
  disableDynamicPositionSizing?: boolean;
  selectionMode?: IngestSelectionMode;
  skipMints?: string[];
  openCooldowns?: TargetOpenCooldownSnapshot[];
};

type PumpIndexes = {
  tokenByMint: Map<string, ReturnType<typeof normalizePumpTokenEvent>>;
};

type IngestSource = 'meteora-pools' | 'pump-trades' | 'gmgn-trader';

type TaggedIngestSourceError = Error & {
  ingestSource?: IngestSource;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tagIngestSourceError(source: IngestSource, error: unknown): TaggedIngestSourceError {
  const tagged = error instanceof Error ? error as TaggedIngestSourceError : new Error(String(error)) as TaggedIngestSourceError;
  tagged.ingestSource = source;
  return tagged;
}

function resolveIngestSourceFailure(error: unknown) {
  const tagged = error instanceof Error ? error as TaggedIngestSourceError : undefined;
  const source = tagged?.ingestSource ?? 'meteora-pools';
  const message = error instanceof Error ? error.message : String(error);

  if (source === 'pump-trades') {
    return {
      source,
      blockReason: 'pump-trades-fetch-failed',
      logLabel: 'Pump trades',
      message
    };
  }

  if (source === 'gmgn-trader') {
    return {
      source,
      blockReason: 'gmgn-trader-fetch-failed',
      logLabel: 'GMGN trader',
      message
    };
  }

  return {
    source: 'meteora-pools' as const,
    blockReason: 'meteora-pools-fetch-failed',
    logLabel: 'Meteora pools',
    message
  };
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

function formatAuxiliarySignalSummary(candidates: IngestCandidate[]) {
  if (candidates.length === 0) {
    return "aux=none auxScored=0/0 auxMax=0";
  }

  const statusCounts = candidates.reduce<Record<string, number>>((counts, candidate) => {
    const status = candidate.auxSignalStatus ?? "disabled";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  const statusText = Object.entries(statusCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => status + ":" + count)
    .join(",");
  const scoredCount = candidates.filter((candidate) => (candidate.auxSignalScore ?? 0) > 0).length;
  const maxScore = candidates.reduce((max, candidate) => Math.max(max, candidate.auxSignalScore ?? 0), 0);

  return "aux=" + (statusText || "none") + " auxScored=" + scoredCount + "/" + candidates.length + " auxMax=" + Number(maxScore.toFixed(2));
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

function rawLamportsAmountIsPositive(value: unknown) {
  if (typeof value === 'string') {
    return /^\d+$/.test(value) && BigInt(value) > 0n;
  }

  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function lpPositionRequiresTokenQuote(position: NonNullable<LiveAccountState['walletLpPositions']>[number]) {
  return rawLamportsAmountIsPositive(position.withdrawTokenAmountRaw)
    || rawLamportsAmountIsPositive(position.withdrawTokenAmountLamports)
    || rawLamportsAmountIsPositive(position.unclaimedFeeTokenAmountRaw)
    || rawLamportsAmountIsPositive(position.unclaimedFeeTokenAmountLamports);
}

function hasRequiredLpTokenQuotes(position: NonNullable<LiveAccountState['walletLpPositions']>[number]) {
  const valuationSource = typeof position.valuationSource === 'string' ? position.valuationSource : '';
  const needsWithdrawTokenQuote = rawLamportsAmountIsPositive(position.withdrawTokenAmountRaw)
    || rawLamportsAmountIsPositive(position.withdrawTokenAmountLamports);
  const needsFeeTokenQuote = rawLamportsAmountIsPositive(position.unclaimedFeeTokenAmountRaw)
    || rawLamportsAmountIsPositive(position.unclaimedFeeTokenAmountLamports);

  if (
    needsWithdrawTokenQuote
    && (
      !valuationSource.includes('swap-provider-sell-quote')
      || typeof position.withdrawTokenValueSol !== 'number'
      || !Number.isFinite(position.withdrawTokenValueSol)
    )
  ) {
    return false;
  }

  if (
    needsFeeTokenQuote
    && (
      !valuationSource.includes('fee-swap-provider-sell-quote')
      || typeof position.unclaimedFeeTokenValueSol !== 'number'
      || !Number.isFinite(position.unclaimedFeeTokenValueSol)
    )
  ) {
    return false;
  }

  return true;
}

function mergeValuationTrustForSignal(
  current: 'exit_quote' | 'market_price' | 'fallback_display' | undefined,
  next: 'exit_quote' | 'market_price' | 'fallback_display' | undefined
) {
  if (!next) {
    return current;
  }

  if (current === 'fallback_display' || next === 'fallback_display') {
    return 'fallback_display' as const;
  }

  if (current === 'market_price' || next === 'market_price') {
    return 'market_price' as const;
  }

  return 'exit_quote' as const;
}

function resolveLpPositionSignal(
  accountState: LiveAccountState | undefined,
  input: { mint: string; poolAddress: string }
) {
  if (!accountState || input.mint.length === 0) {
    return {};
  }

  const positions = [
    ...(accountState.walletLpPositions ?? []),
    ...(accountState.journalLpPositions ?? [])
  ].filter((position) =>
    position.mint === input.mint && (position.hasLiquidity ?? true)
  );

  const exactPoolMatches = positions.filter((position) => position.poolAddress === input.poolAddress);
  const relevantPositions = exactPoolMatches.length > 0 ? exactPoolMatches : positions;

  if (relevantPositions.length === 0) {
    return {};
  }

  const lpSolDepletedBins = relevantPositions.reduce<number | undefined>((maxBins, position) => {
    if (typeof position.solDepletedBins !== 'number') {
      return maxBins;
    }

    return typeof maxBins === 'number'
      ? Math.max(maxBins, position.solDepletedBins)
      : position.solDepletedBins;
  }, undefined);
  const trustedValuePositions = relevantPositions.filter((position) => {
    const valuationSource = typeof position.valuationSource === 'string' ? position.valuationSource : '';
    return position.valuationStatus === 'ready'
      && position.valuationCompleteness === 'complete'
      && (
        position.valuationTrust === 'exit_quote'
        || (
          valuationSource.includes('withdraw-simulation')
          && !valuationSource.includes('dlmm-active-bin-price-fallback')
          && (!lpPositionRequiresTokenQuote(position) || hasRequiredLpTokenQuotes(position))
        )
      )
      && typeof (position.lpTotalValueSol ?? position.currentValueSol) === 'number';
  });
  const lpCurrentValueSol = trustedValuePositions.length === relevantPositions.length
    ? trustedValuePositions.reduce<number | undefined>((sum, position) => (sum ?? 0) + (position.lpTotalValueSol ?? position.currentValueSol!), undefined)
    : undefined;
  const sumTrustedPositionValues = (
    selector: (position: (typeof trustedValuePositions)[number]) => number | undefined
  ) => {
    if (trustedValuePositions.length !== relevantPositions.length) {
      return undefined;
    }

    let sum = 0;
    for (const position of trustedValuePositions) {
      const value = selector(position);
      if (typeof value !== 'number') {
        return undefined;
      }
      sum += value;
    }
    return sum;
  };
  const lpLiquidityValueSol = trustedValuePositions.length === relevantPositions.length
    ? sumTrustedPositionValues((position) => position.liquidityValueSol)
    : undefined;
  const lpUnclaimedFeeValueSol = trustedValuePositions.length === relevantPositions.length
    ? sumTrustedPositionValues((position) => position.unclaimedFeeValueSol)
    : undefined;
  const lpClaimedFeeValueSol = trustedValuePositions.length === relevantPositions.length
    ? trustedValuePositions.reduce<number>((sum, position) => sum + (position.claimedFeeValueSol ?? 0), 0)
    : undefined;
  const lpRecoverableRentSol = trustedValuePositions.length === relevantPositions.length
    ? trustedValuePositions.reduce<number>((sum, position) => sum + (position.recoverableRentSol ?? 0), 0)
    : undefined;
  const lpTotalValueSol = lpCurrentValueSol;
  const exitQuoteValueSol = trustedValuePositions.length === relevantPositions.length
    ? sumTrustedPositionValues((position) => position.exitQuoteValueSol)
    : undefined;
  const marketValueSol = trustedValuePositions.length === relevantPositions.length
    ? sumTrustedPositionValues((position) => position.marketValueSol)
    : undefined;
  const displayValueSol = trustedValuePositions.length === relevantPositions.length
    ? sumTrustedPositionValues((position) => position.displayValueSol)
    : undefined;
  const valuationTrust = trustedValuePositions.length === relevantPositions.length
    ? trustedValuePositions.reduce<'exit_quote' | 'market_price' | 'fallback_display' | undefined>(
        (trust, position) => mergeValuationTrustForSignal(trust, position.valuationTrust),
        undefined
      )
    : undefined;
  const lpValuationStatus = trustedValuePositions.length === relevantPositions.length ? 'ready' : 'unavailable';
  const lpValuationReason = lpValuationStatus === 'ready'
    ? ''
    : relevantPositions.map((position) => position.valuationReason).filter(Boolean).join(';') || 'missing-trusted-exit-value';
  const lpValuationSource = lpValuationStatus === 'ready'
    ? Array.from(new Set(trustedValuePositions.map((position) => position.valuationSource))).filter(Boolean).join('+')
    : undefined;
  const lpUnclaimedFeeSol = relevantPositions.reduce<number | undefined>((sum, position) => {
    if (typeof position.unclaimedFeeSol !== 'number') {
      return sum;
    }

    return (sum ?? 0) + position.unclaimedFeeSol;
  }, undefined);

  return {
    lpSolDepletedBins,
    lpCurrentValueSol,
    lpLiquidityValueSol,
    lpTotalValueSol,
    exitQuoteValueSol,
    marketValueSol,
    displayValueSol,
    lpUnclaimedFeeSol,
    lpUnclaimedFeeValueSol,
    lpClaimedFeeValueSol,
    lpRecoverableRentSol,
    lpValuationStatus,
    lpValuationReason,
    lpValuationSource,
    lpValuationCompleteness: lpValuationStatus === 'ready' ? 'complete' : 'incomplete',
    lpValuationTrust: valuationTrust,
    valuationStatus: lpValuationStatus,
    valuationReason: lpValuationReason,
    valuationSource: lpValuationSource,
    valuationCompleteness: lpValuationStatus === 'ready' ? 'complete' : 'incomplete',
    valuationTrust
  };
}

function isPlaceholderEndpoint(url: string) {
  return url.includes('example.invalid');
}

async function maybeFetchPumpTradesRows(input: IngestContextBuilderInput) {
  try {
    if (input.fetchPumpTradesImpl) {
      return await input.fetchPumpTradesImpl();
    }

    if (isPlaceholderEndpoint(SOURCE_ENDPOINTS.pumpTrades)) {
      return [];
    }

    return await fetchPumpTrades();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Ingest] Pump trades fetch failed; continuing without pump context: ${message}`);
    return [];
  }
}

async function maybeFetchTraderSnapshot(input: IngestContextBuilderInput) {
  if (!input.traderWallet) {
    return null;
  }

  try {
    if (input.fetchGmgnTraderImpl) {
      return normalizeGmgnTrader(await input.fetchGmgnTraderImpl(input.traderWallet));
    }

    if (isPlaceholderEndpoint(SOURCE_ENDPOINTS.gmgnTraderBase)) {
      return null;
    }

    return normalizeGmgnTrader(await fetchGmgnTrader(input.traderWallet));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Ingest] GMGN trader fetch failed; continuing without trader context: ${message}`);
    return null;
  }
}

function defaultRequestedPositionSol(maxLivePositionSol: number) {
  return Math.min(0.05, maxLivePositionSol);
}

function resolveCandidateRequestedPositionSol(input: {
  strategy: StrategyId;
  requestedPositionSol: number;
  candidate: Pick<IngestCandidate, 'liquidityUsd' | 'safetyScore'>;
  disableDynamicPositionSizing?: boolean;
}) {
  if (input.strategy !== 'new-token-v1' || input.disableDynamicPositionSizing) {
    return input.requestedPositionSol;
  }

  return computeDynamicPositionSol(
    input.candidate.liquidityUsd,
    input.requestedPositionSol,
    undefined,
    { safetyScore: input.candidate.safetyScore }
  );
}

function buildDeferredSafetyResults(mints: string[]): TokenSafetyResult[] {
  return mints.map((mint) => ({
    mint,
    safe: false,
    safetyScore: 0,
    maxScore: 120,
    error: GMGN_SAFETY_DEFERRED_ERROR
  }));
}

function resolveNoCandidateBlockReason(input: {
  prefilteredCount: number;
  postLpCount: number;
  postSafetyCount: number;
  postRecentlyClosedCooldownCount: number;
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

    if (deferredChecks.length > 0) {
      return {
        blockReason: 'gmgn-safety-deferred',
        blockDetails: input.inScanWindow
          ? `${deferredChecks.length} uncached GMGN safety checks were deferred by batch throttling`
          : `${deferredChecks.length} uncached GMGN safety checks were deferred because scan window is closed (maxBatchSize=0)`
      };
    }

    return {
      blockReason: 'no-safe-candidate',
      blockDetails: 'all LP-eligible candidates failed safety checks'
    };
  }

  if (input.postRecentlyClosedCooldownCount === 0) {
    return {
      blockReason: 'recently-closed-mint-cooldown',
      blockDetails: 'all safe candidates are still inside recently closed mint reopen cooldown'
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

function resolveActiveLpMaintenanceCandidate(input: {
  candidates: IngestCandidate[];
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot;
  openCooldowns?: TargetOpenCooldownSnapshot[];
  now: Date;
}) {
  const activeCooldowns = activeOpenCooldownTargets({
    cooldowns: input.openCooldowns,
    now: input.now
  });
  const activeCandidates = input.candidates.filter((candidate) =>
    candidate.hasLpPosition &&
    !activeCooldowns.some((cooldown) => targetOpenCooldownMatches(candidate, cooldown))
  );
  if (activeCandidates.length === 0) {
    return null;
  }

  const statePool = input.positionState?.activePoolAddress ?? '';
  const stateMint = input.positionState?.activeMint ?? '';

  if (statePool) {
    const poolMatch = activeCandidates.find((candidate) => candidate.address === statePool);
    if (poolMatch) {
      return poolMatch;
    }
  }

  if (stateMint) {
    const mintMatch = activeCandidates.find((candidate) => candidate.mint === stateMint);
    if (mintMatch) {
      return mintMatch;
    }
  }

  if (!stateMint && !statePool) {
    return null;
  }

  return null;
}

function buildLpSignalTraderFields(lpPositionSignal: ReturnType<typeof resolveLpPositionSignal>) {
  return {
    ...(typeof lpPositionSignal.lpSolDepletedBins === 'number'
      ? { lpSolDepletedBins: lpPositionSignal.lpSolDepletedBins }
      : {}),
    ...(typeof lpPositionSignal.lpCurrentValueSol === 'number'
      ? { lpCurrentValueSol: lpPositionSignal.lpCurrentValueSol }
      : {}),
    ...(typeof lpPositionSignal.lpLiquidityValueSol === 'number'
      ? { lpLiquidityValueSol: lpPositionSignal.lpLiquidityValueSol }
      : {}),
    ...(typeof lpPositionSignal.lpTotalValueSol === 'number'
      ? { lpTotalValueSol: lpPositionSignal.lpTotalValueSol }
      : {}),
    ...(typeof lpPositionSignal.exitQuoteValueSol === 'number'
      ? { exitQuoteValueSol: lpPositionSignal.exitQuoteValueSol }
      : {}),
    ...(typeof lpPositionSignal.marketValueSol === 'number'
      ? { marketValueSol: lpPositionSignal.marketValueSol }
      : {}),
    ...(typeof lpPositionSignal.displayValueSol === 'number'
      ? { displayValueSol: lpPositionSignal.displayValueSol }
      : {}),
    ...(typeof lpPositionSignal.lpUnclaimedFeeSol === 'number'
      ? { lpUnclaimedFeeSol: lpPositionSignal.lpUnclaimedFeeSol }
      : {}),
    ...(typeof lpPositionSignal.lpUnclaimedFeeValueSol === 'number'
      ? { lpUnclaimedFeeValueSol: lpPositionSignal.lpUnclaimedFeeValueSol }
      : {}),
    ...(typeof lpPositionSignal.lpRecoverableRentSol === 'number'
      ? { lpRecoverableRentSol: lpPositionSignal.lpRecoverableRentSol }
      : {}),
    ...(typeof lpPositionSignal.lpClaimedFeeValueSol === 'number'
      ? { lpClaimedFeeValueSol: lpPositionSignal.lpClaimedFeeValueSol }
      : {}),
    ...(typeof lpPositionSignal.valuationStatus === 'string'
      ? { valuationStatus: lpPositionSignal.valuationStatus, lpValuationStatus: lpPositionSignal.valuationStatus }
      : {}),
    ...(typeof lpPositionSignal.valuationReason === 'string'
      ? { valuationReason: lpPositionSignal.valuationReason, lpValuationReason: lpPositionSignal.valuationReason }
      : {}),
    ...(typeof lpPositionSignal.valuationSource === 'string'
      ? { valuationSource: lpPositionSignal.valuationSource, lpValuationSource: lpPositionSignal.valuationSource }
      : {}),
    ...(typeof lpPositionSignal.valuationCompleteness === 'string'
      ? {
        valuationCompleteness: lpPositionSignal.valuationCompleteness,
        lpValuationCompleteness: lpPositionSignal.valuationCompleteness
      }
      : {}),
    ...(typeof lpPositionSignal.valuationTrust === 'string'
      ? {
        valuationTrust: lpPositionSignal.valuationTrust,
        lpValuationTrust: lpPositionSignal.valuationTrust
      }
      : {})
  };
}

function buildActiveLpMaintenanceContext(
  input: IngestContextBuilderInput,
  requestedPositionSol: number,
  sessionActive: boolean,
  slippageBps: number,
  traderSnapshot: ReturnType<typeof normalizeGmgnTrader> | null,
  candidate: IngestCandidate
): IngestBackedCycleInput {
  const lpPositionSignal = resolveLpPositionSignal(input.accountState, {
    mint: candidate.mint,
    poolAddress: candidate.address
  });

  const context: DecisionContextInput = {
    pool: {
      address: candidate.address,
      liquidityUsd: candidate.liquidityUsd,
      hasSolRoute: candidate.hasSolRoute,
      capturedAt: candidate.capturedAt,
      candidateCount: 0,
      binStep: candidate.binStep,
      baseFeePct: candidate.baseFeePct,
      volume24h: candidate.volume24h,
      feeTvlRatio24h: candidate.feeTvlRatio24h,
      auxSignalScore: candidate.auxSignalScore ?? 0,
      auxSignalStatus: candidate.auxSignalStatus ?? 'disabled'
    },
    token: {
      mint: candidate.mint,
      symbol: candidate.symbol,
      liquidityUsd: candidate.liquidityUsd,
      hasSolRoute: candidate.hasSolRoute,
      inSession: sessionActive,
      holders: candidate.holders,
      expectedOutSol: requestedPositionSol,
      capturedAt: candidate.capturedAt,
      dexscreenerBoostAmount: candidate.dexscreenerBoostAmount ?? 0,
      dexscreenerHasProfile: candidate.dexscreenerHasProfile ?? false,
      jupiterOrganicScore: candidate.jupiterOrganicScore ?? 0,
      jupiterTrendingRank: candidate.jupiterTrendingRank ?? 0,
      coingeckoTrendingRank: candidate.coingeckoTrendingRank ?? 0
    },
    trader: {
      wallet: input.traderWallet ?? '',
      hasInventory: true,
      hasLpPosition: true,
      ...buildLpSignalTraderFields(lpPositionSignal),
      labels: traderSnapshot?.labels ?? [],
      pnlUsd: traderSnapshot?.pnlUsd ?? 0,
      freshnessMs: traderSnapshot?.freshnessMs ?? 0
    },
    route: {
      hasSolRoute: candidate.hasSolRoute,
      expectedOutSol: requestedPositionSol,
      slippageBps,
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

function resolveRecentlyClosedExcludedMints(input: {
  positionState?: PositionStateSnapshot;
  now: Date;
}) {
  const mint = input.positionState?.lastClosedMint ?? '';
  const closedAt = input.positionState?.lastClosedAt ?? '';
  const closedAtMs = Date.parse(closedAt);
  if (!mint || !Number.isFinite(closedAtMs)) {
    return [];
  }

  return input.now.getTime() - closedAtMs < RECENTLY_CLOSED_MINT_REOPEN_COOLDOWN_MS ? [mint] : [];
}

function activeOpenCooldownTargets(input: {
  cooldowns?: TargetOpenCooldownSnapshot[];
  now: Date;
}) {
  return (input.cooldowns ?? [])
    .filter((cooldown) => cooldown.cooldownUntil > input.now.toISOString());
}

function targetOpenCooldownMatches(
  candidate: { address: string; mint: string },
  cooldown: { poolAddress?: string; tokenMint?: string }
) {
  const poolAddress = cooldown.poolAddress ?? '';
  const tokenMint = cooldown.tokenMint ?? '';
  const poolMatches = !poolAddress || poolAddress === candidate.address;
  const mintMatches = !tokenMint || tokenMint === candidate.mint;
  return poolMatches && mintMatches;
}

function filterOpenCooldownCandidates(
  candidates: IngestCandidate[],
  input: {
    cooldowns?: TargetOpenCooldownSnapshot[];
    now: Date;
  }
) {
  const cooldowns = activeOpenCooldownTargets(input);
  if (cooldowns.length === 0) {
    return candidates;
  }

  return candidates.filter((candidate) =>
    candidate.hasInventory ||
    candidate.hasLpPosition ||
    !cooldowns.some((cooldown) => targetOpenCooldownMatches(candidate, cooldown))
  );
}

function resolveOpenCandidateExcludedMints(input: {
  accountState?: LiveAccountState;
  positionState?: PositionStateSnapshot;
  now: Date;
  skipMints?: string[];
}) {
  const excluded = new Set<string>();

  for (const mint of resolveRecentlyClosedExcludedMints({
    positionState: input.positionState,
    now: input.now
  })) {
    if (mint) {
      excluded.add(mint);
    }
  }

  for (const mint of input.skipMints ?? []) {
    if (mint) {
      excluded.add(mint);
    }
  }

  if (input.positionState?.activeMint && input.positionState.lifecycleState !== 'closed') {
    excluded.add(input.positionState.activeMint);
  }

  for (const token of [
    ...(input.accountState?.walletTokens ?? []),
    ...(input.accountState?.journalTokens ?? [])
  ]) {
    if (token.mint && token.mint !== SOL_MINT && token.amount > 0) {
      excluded.add(token.mint);
    }
  }

  for (const position of [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ]) {
    if (position.mint && position.mint !== SOL_MINT && (position.hasLiquidity ?? true)) {
      excluded.add(position.mint);
    }
  }

  return [...excluded];
}

function resolveOpenCandidateExcludedTargets(input: {
  cooldowns?: TargetOpenCooldownSnapshot[];
  now: Date;
}) {
  return activeOpenCooldownTargets({
    cooldowns: input.cooldowns,
    now: input.now
  }).map((cooldown) => ({
    poolAddress: cooldown.poolAddress,
    tokenMint: cooldown.tokenMint
  }));
}

function resolveAccountBackedActiveLpCandidate(input: IngestContextBuilderInput, now: Date): IngestCandidate | null {
  const positions = [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ].filter((position) => position.mint !== SOL_MINT && (position.hasLiquidity ?? true));

  if (positions.length === 0) {
    return null;
  }

  const state = input.positionState;

  // When there are multiple active LP positions, the maintenance pass
  // must process ALL of them — not just the one currently tracked in
  // positionState.  This avoids a deadlock where a tracked "hold" LP
  // blocks untracked LPs from ever being evaluated for exit.
  //
  // Strategy: first pick any LP that is NOT matched by positionState
  // (untracked), so it gets evaluated by runLiveCycle's full
  // evaluateActiveLpPositions machinery.  Once it triggers an exit (or
  // is otherwise resolved), it falls out of the wallet and the
  // positionState is updated; the next tick naturally moves on to the
  // next LP.  Only when every active LP matches positionState do we
  // stay in normal single-LP maintenance mode.
  if (state?.activeMint || state?.activePoolAddress || state?.chainPositionAddress) {
    const untracked = positions.find((position) => {
      if (state.chainPositionAddress) {
        return position.positionAddress !== state.chainPositionAddress
          && position.chainPositionAddress !== state.chainPositionAddress;
      }
      if (state.activePoolAddress) {
        return position.poolAddress !== state.activePoolAddress;
      }
      return position.mint !== state.activeMint;
    });
    if (untracked) {
      return buildLpCandidate(untracked, input.accountState, now);
    }
  }

  const byChain = state?.chainPositionAddress
    ? positions.find((position) => position.positionAddress === state.chainPositionAddress)
    : undefined;
  const byPool = state?.activePoolAddress
    ? positions.find((position) => position.poolAddress === state.activePoolAddress)
    : undefined;
  const byMint = state?.activeMint
    ? positions.find((position) => position.mint === state.activeMint)
    : undefined;

  if (!state?.activeMint && !state?.activePoolAddress && !state?.chainPositionAddress) {
    return buildLpCandidate(positions[0], input.accountState, now);
  }

  const position = byChain ?? byPool ?? byMint;
  if (!position) {
    return null;
  }

  return buildLpCandidate(position, input.accountState, now);
}

function buildLpCandidate(
  position: NonNullable<LiveAccountState['walletLpPositions']>[number],
  accountState: LiveAccountState | undefined,
  now: Date
): IngestCandidate {
  const token = [
    ...(accountState?.walletTokens ?? []),
    ...(accountState?.journalTokens ?? [])
  ].find((item) => item.mint === position.mint);
  const fill = [...(accountState?.fills ?? [])]
    .reverse()
    .find((item) => item.mint === position.mint && item.symbol);
  const symbol = token?.symbol ?? fill?.symbol ?? position.mint.slice(0, 6);
  const valueSol = typeof position.currentValueSol === 'number'
    ? position.currentValueSol
    : typeof position.withdrawSolAmount === 'number'
      ? position.withdrawSolAmount
      : 0;

  return {
    ...EMPTY_AUXILIARY_SIGNAL_FIELDS,
    address: position.poolAddress,
    mint: position.mint,
    symbol,
    chain: 'solana',
    quoteMint: SOL_MINT,
    liquidityUsd: Math.max(1, valueSol * 200),
    hasSolRoute: true,
    capturedAt: position.lastValuationAt ?? now.toISOString(),
    holders: 0,
    hasInventory: true,
    hasLpPosition: true,
    binStep: 0,
    baseFeePct: 0,
    volume24h: 0,
    feeTvlRatio24h: 0
  };
}

function resolveUntrackedAccountLpCandidate(input: IngestContextBuilderInput, now: Date): IngestCandidate | null {
  const state = input.positionState;

  const positions = [
    ...(input.accountState?.walletLpPositions ?? []),
    ...(input.accountState?.journalLpPositions ?? [])
  ].filter((position) => position.mint !== SOL_MINT && (position.hasLiquidity ?? true));

  if (positions.length === 0) {
    return null;
  }

  // Pick the first active LP that is NOT tracked by positionState.
  // This allows the default pass to flush untracked LPs even when a
  // tracked LP is holding (max-hold not yet triggered, PnL in range).
  const position = (state?.activeMint || state?.activePoolAddress || state?.chainPositionAddress)
    ? positions.find((pos) => {
        if (state.chainPositionAddress) {
          return pos.positionAddress !== state.chainPositionAddress
            && pos.chainPositionAddress !== state.chainPositionAddress;
        }
        if (state.activePoolAddress) {
          return pos.poolAddress !== state.activePoolAddress;
        }
        return pos.mint !== state.activeMint;
      }) ?? null
    : positions[0];

  if (!position) {
    return null;
  }

  return buildLpCandidate(position, input.accountState, now);
}

async function buildCandidatePoolBackedCycleInput(
  input: IngestContextBuilderInput,
  contextInput: {
    now: Date;
    config: Awaited<ReturnType<typeof loadStrategyConfig>>;
    sessionActive: boolean;
  }
): Promise<IngestBackedCycleInput> {
  const { now, config, sessionActive } = contextInput;
  const requestedPositionSol = input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol);
  const activePositionsCount = countActiveInventoryPositions(input.accountState);
  const maxActivePositions = input.maxActivePositions ?? 5;

  if (activePositionsCount >= maxActivePositions) {
    return buildFallbackContext(input, requestedPositionSol, sessionActive, config.solRouteLimits.maxSlippageBps, null, {
      blockReason: 'candidate-pool-capacity-full',
      blockDetails: 'active position capacity is full; new candidate opens are disabled'
    });
  }

  if (!input.candidatePoolReader) {
    return buildFallbackContext(input, requestedPositionSol, sessionActive, config.solRouteLimits.maxSlippageBps, null, {
      blockReason: 'candidate-pool-unavailable',
      blockDetails: 'candidate pool reader is not configured'
    });
  }

  let entry: CandidatePoolEntry | null;
  try {
    entry = await input.candidatePoolReader.selectOpenableCandidate(input.strategy, {
      now,
      maxAgeMs: input.candidatePoolMaxAgeMs,
      excludedMints: input.selectionMode === 'new-open-only'
        ? resolveOpenCandidateExcludedMints({
            accountState: input.accountState,
            positionState: input.positionState,
            now,
            skipMints: input.skipMints
          })
        : resolveRecentlyClosedExcludedMints({ positionState: input.positionState, now }),
      excludedTargets: resolveOpenCandidateExcludedTargets({
        cooldowns: input.openCooldowns,
        now
      })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Ingest] Candidate pool read failed closed for new opens: ${message}`);
    return buildFallbackContext(input, requestedPositionSol, sessionActive, config.solRouteLimits.maxSlippageBps, null, {
      blockReason: 'candidate-pool-unavailable',
      blockDetails: message
    });
  }

  if (!entry) {
    return buildFallbackContext(input, requestedPositionSol, sessionActive, config.solRouteLimits.maxSlippageBps, null, {
      blockReason: 'candidate-pool-no-openable-candidate',
      blockDetails: 'candidate pool has no fresh openable candidate'
    });
  }

  const candidate = {
    ...entry.candidate,
    hasInventory: false,
    hasLpPosition: false,
    safetyScore: entry.score
  };
  const selectedRequestedPositionSol = resolveCandidateRequestedPositionSol({
    strategy: input.strategy,
    requestedPositionSol,
    candidate,
    disableDynamicPositionSizing: input.disableDynamicPositionSizing
  });
  const lpPositionSignal = resolveLpPositionSignal(input.accountState, {
    mint: candidate.mint,
    poolAddress: candidate.address
  });

  const context: DecisionContextInput = {
    pool: {
      address: candidate.address,
      liquidityUsd: candidate.liquidityUsd,
      hasSolRoute: candidate.hasSolRoute,
      capturedAt: candidate.capturedAt,
      candidateCount: 1,
      binStep: candidate.binStep,
      baseFeePct: candidate.baseFeePct,
      volume24h: candidate.volume24h,
      feeTvlRatio24h: candidate.feeTvlRatio24h,
      auxSignalScore: candidate.auxSignalScore ?? 0,
      auxSignalStatus: candidate.auxSignalStatus ?? 'disabled',
      candidatePoolStatus: entry.status,
      candidatePoolScore: entry.score,
      candidatePoolUpdatedAt: entry.updatedAt
    },
    token: {
      mint: candidate.mint,
      symbol: candidate.symbol,
      liquidityUsd: candidate.liquidityUsd,
      hasSolRoute: candidate.hasSolRoute,
      inSession: sessionActive,
      holders: candidate.holders,
      expectedOutSol: selectedRequestedPositionSol,
      capturedAt: candidate.capturedAt,
      dexscreenerBoostAmount: candidate.dexscreenerBoostAmount ?? 0,
      dexscreenerHasProfile: candidate.dexscreenerHasProfile ?? false,
      jupiterOrganicScore: candidate.jupiterOrganicScore ?? 0,
      jupiterTrendingRank: candidate.jupiterTrendingRank ?? 0,
      coingeckoTrendingRank: candidate.coingeckoTrendingRank ?? 0
    },
    trader: {
      wallet: input.traderWallet ?? '',
      hasInventory: candidate.hasInventory,
      hasLpPosition: candidate.hasLpPosition,
      ...buildLpSignalTraderFields(lpPositionSignal),
      labels: [],
      pnlUsd: 0,
      freshnessMs: 0
    },
    route: {
      hasSolRoute: candidate.hasSolRoute,
      expectedOutSol: selectedRequestedPositionSol,
      slippageBps: config.solRouteLimits.maxSlippageBps,
      token: candidate.symbol,
      poolAddress: candidate.address
    }
  };

  await appendCandidateScanBestEffort({
    sink: input.candidateScanSink,
    strategy: input.strategy,
    now,
    poolCount: 1,
    prefilteredCount: 1,
    postLpCount: 1,
    postSafetyCount: 1,
    postRecentlyClosedCooldownCount: 1,
    eligibleSelectionCount: 1,
    inScanWindow: isInScanWindow(now),
    activePositionsCount,
    allCandidates: [candidate],
    lpEligibleCandidates: [candidate],
    safeCandidates: [candidate],
    safetyDiagnostics: null,
    selectedCandidate: candidate,
    sessionPhase: sessionActive ? 'active' : 'closed'
  });

  return {
    context,
    requestedPositionSol: selectedRequestedPositionSol,
    sessionPhase: sessionActive ? 'active' : 'closed',
    evolutionWatchlistCandidates: [{
      tokenMint: candidate.mint,
      tokenSymbol: candidate.symbol,
      poolAddress: candidate.address,
      sourceReason: 'selected',
      trackedSince: now.toISOString()
    }]
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
    ...EMPTY_AUXILIARY_SIGNAL_FIELDS,
    address: readString(payload, ['address', 'poolAddress', 'pool_address']),
    mint,
    symbol: tokenEvent?.symbol || symbol,
    chain: 'solana',
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

function buildCandidateScanRecords(input: {
  strategy: StrategyId;
  capturedAt: string;
  activePositionsCount: number;
  sessionPhase: 'active' | 'closed';
  allCandidates: IngestCandidate[];
  lpEligibleCandidates: IngestCandidate[];
  safeCandidates: IngestCandidate[];
  safetyDiagnostics: SafetyFilterDiagnostics | null;
  selectedCandidate: IngestCandidate | null;
}) {
  const lpEligibleKeys = new Set(input.lpEligibleCandidates.map((candidate) => `${candidate.address}:${candidate.mint}`));
  const safeKeys = new Set(input.safeCandidates.map((candidate) => `${candidate.address}:${candidate.mint}`));
  const rejectedBySafety = new Map(
    (input.safetyDiagnostics?.rejected ?? []).map((candidate) => [candidate.mint, candidate] as const)
  );
  const selectedKey = input.selectedCandidate
    ? `${input.selectedCandidate.address}:${input.selectedCandidate.mint}`
    : '';

  return input.allCandidates.map((candidate, index) => {
    const key = `${candidate.address}:${candidate.mint}`;
    const safeCandidate = input.safeCandidates.find((item) => item.address === candidate.address && item.mint === candidate.mint);
    const safetyRejected = rejectedBySafety.get(candidate.mint);
    const rejectedByLp = !lpEligibleKeys.has(key);
    const rejectedBySafetyStage = lpEligibleKeys.has(key) && !safeKeys.has(key);
    const selected = key === selectedKey;
    const enrichedCandidate = safeCandidate ?? candidate;

    let rejectionStage: CandidateSampleRecord['rejectionStage'] = 'none';
    let blockedReason = '';

    if (rejectedByLp) {
      rejectionStage = 'lp_eligibility';
      blockedReason = 'lp-thresholds-not-met';
    } else if (rejectedBySafetyStage) {
      rejectionStage = 'safety';
      blockedReason = safetyRejected?.rejectReasons?.join(',') || safetyRejected?.error || 'safety-check-failed';
    } else if (!selected && selectedKey.length > 0) {
      rejectionStage = 'selection';
      blockedReason = 'selected-other-candidate';
    }

    const selectionRank = selected
      ? 1
      : safeKeys.has(key)
        ? input.safeCandidates.findIndex((item) => item.address === candidate.address && item.mint === candidate.mint) + 1
        : index + 1;

    return {
      sampleId: `${input.strategy}:${input.capturedAt}:${candidate.address || candidate.mint || index}`,
      capturedAt: input.capturedAt,
      strategyId: input.strategy,
      cycleId: `${input.strategy}:${input.capturedAt}`,
      tokenMint: candidate.mint,
      tokenSymbol: candidate.symbol,
      poolAddress: candidate.address,
      liquidityUsd: candidate.liquidityUsd,
      holders: candidate.holders,
      safetyScore: enrichedCandidate.safetyScore ?? safetyRejected?.safetyScore ?? 0,
      auxSignalScore: enrichedCandidate.auxSignalScore ?? 0,
      dexscreenerBoostAmount: enrichedCandidate.dexscreenerBoostAmount ?? 0,
      dexscreenerHasProfile: enrichedCandidate.dexscreenerHasProfile ?? false,
      jupiterOrganicScore: enrichedCandidate.jupiterOrganicScore ?? 0,
      jupiterTrendingRank: enrichedCandidate.jupiterTrendingRank ?? 0,
      coingeckoTrendingRank: enrichedCandidate.coingeckoTrendingRank ?? 0,
      auxSignalStatus: enrichedCandidate.auxSignalStatus ?? 'disabled',
      volume24h: candidate.volume24h,
      feeTvlRatio24h: candidate.feeTvlRatio24h,
      binStep: candidate.binStep,
      hasInventory: candidate.hasInventory,
      hasLpPosition: candidate.hasLpPosition,
      selected,
      selectionRank: Math.max(selectionRank, 1),
      blockedReason,
      rejectionStage,
      runtimeMode: 'healthy',
      sessionPhase: input.sessionPhase === 'active' ? 'active' : 'closed'
    } satisfies CandidateSampleRecord;
  });
}

async function appendCandidateScanBestEffort(input: {
  sink?: IngestContextBuilderInput['candidateScanSink'];
  strategy: StrategyId;
  now: Date;
  poolCount: number;
  prefilteredCount: number;
  postLpCount: number;
  postSafetyCount: number;
  postRecentlyClosedCooldownCount: number;
  eligibleSelectionCount: number;
  inScanWindow: boolean;
  activePositionsCount: number;
  blockedReason?: string;
  allCandidates: IngestCandidate[];
  lpEligibleCandidates: IngestCandidate[];
  safeCandidates: IngestCandidate[];
  safetyDiagnostics: SafetyFilterDiagnostics | null;
  selectedCandidate: IngestCandidate | null;
  sessionPhase: 'active' | 'closed';
}) {
  if (!input.sink) {
    return;
  }

  const capturedAt = input.now.toISOString();
  const scan: CandidateScanRecord = {
    scanId: `${input.strategy}:${capturedAt}`,
    capturedAt,
    strategyId: input.strategy,
    poolCount: input.poolCount,
    prefilteredCount: input.prefilteredCount,
    postLpCount: input.postLpCount,
    postSafetyCount: input.postSafetyCount,
    eligibleSelectionCount: input.eligibleSelectionCount,
    scanWindowOpen: input.inScanWindow,
    activePositionsCount: input.activePositionsCount,
    selectedTokenMint: input.selectedCandidate?.mint ?? '',
    selectedPoolAddress: input.selectedCandidate?.address ?? '',
    blockedReason: input.blockedReason ?? '',
    candidates: buildCandidateScanRecords({
      strategy: input.strategy,
      capturedAt,
      activePositionsCount: input.activePositionsCount,
      sessionPhase: input.sessionPhase,
      allCandidates: input.allCandidates,
      lpEligibleCandidates: input.lpEligibleCandidates,
      safeCandidates: input.safeCandidates,
      safetyDiagnostics: input.safetyDiagnostics,
      selectedCandidate: input.selectedCandidate
    })
  };

  try {
    await input.sink.appendScan(scan);
  } catch (error) {
    console.warn(
      `[Ingest] Candidate scan persistence failed; continuing without evolution evidence: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function buildLiveCycleInputFromIngest(
  input: IngestContextBuilderInput
): Promise<IngestBackedCycleInput> {
  const now = input.now ?? new Date();
  const config = await loadStrategyConfig(STRATEGY_CONFIGS[input.strategy]);
  const sessionActive = isWithinSessionWindows(config.sessionWindows, now);
  const selectionMode = input.selectionMode ?? 'default';
  const businessSemantics = resolvePositionBusinessSemantics({
    accountState: input.accountState,
    positionState: input.positionState,
    maxActivePositions: input.maxActivePositions
  });

  if (selectionMode === 'new-open-only' && !businessSemantics.canOpenNewPosition.allowed) {
    return buildFallbackContext(
      input,
      input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol),
      sessionActive,
      config.solRouteLimits.maxSlippageBps,
      null,
      {
        blockReason: businessSemantics.canOpenNewPosition.reason,
        blockDetails: 'position capacity or pending runtime state blocks new candidate selection'
      }
    );
  }

  const shouldUseAccountBackedMaintenance = selectionMode !== 'new-open-only' && (
    selectionMode === 'maintenance-only'
    || Boolean(input.positionState?.activeMint || input.positionState?.activePoolAddress || input.positionState?.chainPositionAddress)
    || !input.fetchTokenSafetyBatchImpl
  );
  const accountBackedActiveLpCandidate = shouldUseAccountBackedMaintenance
    ? resolveAccountBackedActiveLpCandidate(input, now)
    : null;

  if (accountBackedActiveLpCandidate) {
    console.log(
      `[Ingest] maintenance-pass account-backed active LP context selected; skipping new-candidate ingest mint=${accountBackedActiveLpCandidate.mint} pool=${accountBackedActiveLpCandidate.address}`
    );

    return buildActiveLpMaintenanceContext(
      input,
      input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol),
      sessionActive,
      config.solRouteLimits.maxSlippageBps,
      null,
      accountBackedActiveLpCandidate
    );
  }

  if (selectionMode === 'maintenance-only') {
    return buildFallbackContext(
      input,
      input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol),
      sessionActive,
      config.solRouteLimits.maxSlippageBps,
      null,
      {
        blockReason: 'no-active-lp-maintenance-target',
        blockDetails: 'maintenance-only pass found no active LP position'
      }
    );
  }

  // In default mode with candidate pool, before falling through
  // to select a new openable candidate, check if the account has
  // ANY untracked LP positions that need to be exited first.
  if (selectionMode === 'default' && input.candidatePoolReadEnabled) {
    const untrackedLp = resolveUntrackedAccountLpCandidate(input, now);
    if (untrackedLp) {
      console.log(
        `[Ingest] default-pass account-backed untracked LP context selected; skipping new-candidate ingest mint=${untrackedLp.mint} pool=${untrackedLp.address}`
      );
      return buildActiveLpMaintenanceContext(
        input,
        input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol),
        sessionActive,
        config.solRouteLimits.maxSlippageBps,
        null,
        untrackedLp
      );
    }
  }

  if (input.candidatePoolReadEnabled) {
    return buildCandidatePoolBackedCycleInput(input, {
      now,
      config,
      sessionActive
    });
  }

  let poolRows: Record<string, unknown>[];
  let pumpRows: Record<string, unknown>[];
  let traderSnapshot: ReturnType<typeof normalizeGmgnTrader> | null;

  try {
    [poolRows, pumpRows, traderSnapshot] = await Promise.all([
      (async () => {
        try {
          return await (input.fetchMeteoraPoolsImpl ?? fetchMeteoraPools)({
            pageSize: input.meteoraPageSize ?? 1000,
            query: input.meteoraQuery,
            sortBy: input.meteoraSortBy ?? 'fee_tvl_ratio_1h:desc',
            filterBy: input.meteoraFilterBy ?? 'tvl>=1000 && is_blacklisted=false'
          });
        } catch (error) {
          throw tagIngestSourceError('meteora-pools', error);
        }
      })(),
      (async () => {
        try {
          return await maybeFetchPumpTradesRows(input);
        } catch (error) {
          throw tagIngestSourceError('pump-trades', error);
        }
      })(),
      (async () => {
        try {
          return await maybeFetchTraderSnapshot(input);
        } catch (error) {
          throw tagIngestSourceError('gmgn-trader', error);
        }
      })()
    ]);
  } catch (error) {
    const requestedPositionSol = input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol);
    const failure = resolveIngestSourceFailure(error);

    console.warn(`[Ingest] ${failure.logLabel} fetch failed; falling back to hold-only context: ${failure.message}`);

    return buildFallbackContext(
      input,
      requestedPositionSol,
      sessionActive,
      config.solRouteLimits.maxSlippageBps,
      null,
      {
        blockReason: failure.blockReason,
        blockDetails: failure.message
      }
    );
  }

  const pumpIndexes = buildPumpIndexes(pumpRows, input.traderWallet);
  const maxPoolAgeMs = 3 * 24 * 60 * 60 * 1000;
  const prefilteredRows = poolRows.filter((row) => {
    const payload = rawRecord(row);
    const poolConfig = isRecord(payload.pool_config) ? payload.pool_config : {};
    const isBlacklisted = readBoolean(payload, ['is_blacklisted', 'isBlacklisted']);
    const binStep = readNumber(poolConfig, ['bin_step', 'binStep']);
    const hasSolRoute = resolveHasSolRoute(payload);
    return hasSolRoute && !isBlacklisted && isAllowedMeteoraEntryBinStep(binStep) && isRecentPool(payload, now, maxPoolAgeMs);
  });

  const prefilterCandidates: IngestCandidate[] = prefilteredRows.map((row) =>
    buildCandidate(
      row,
      pumpIndexes,
      input.accountState
    )
  );
  let candidates: IngestCandidate[] = prefilterCandidates;
  const preLpCount = candidates.length;
  const lpEligibleCandidates = filterLpEligibleCandidates(candidates, config);
  candidates = rankCandidatesForSafety(lpEligibleCandidates);
  const postLpCount = lpEligibleCandidates.length;
  const activePositionsCount = countActiveInventoryPositions(input.accountState);
  const maxActivePositions = input.maxActivePositions ?? 5;
  const shouldDeferNewCandidateSafety = activePositionsCount >= maxActivePositions;
  const inScanWindow = isInScanWindow(now);
  const activeLpMaintenanceCandidate = input.selectionMode === 'new-open-only'
    ? null
    : resolveActiveLpMaintenanceCandidate({
        candidates: lpEligibleCandidates,
        accountState: input.accountState,
        positionState: input.positionState,
        openCooldowns: input.openCooldowns,
        now
      });

  if (activeLpMaintenanceCandidate) {
    console.log(
      `[Ingest] Active LP maintenance context selected; skipping new-candidate GMGN safety mint=${activeLpMaintenanceCandidate.mint} pool=${activeLpMaintenanceCandidate.address}`
    );
    await appendCandidateScanBestEffort({
      sink: input.candidateScanSink,
      strategy: input.strategy,
      now,
      poolCount: poolRows.length,
      prefilteredCount: prefilteredRows.length,
      postLpCount,
      postSafetyCount: 0,
      postRecentlyClosedCooldownCount: 0,
      eligibleSelectionCount: 0,
      inScanWindow,
      activePositionsCount,
      blockedReason: 'active-lp-maintenance',
      allCandidates: prefilterCandidates,
      lpEligibleCandidates,
      safeCandidates: [],
      safetyDiagnostics: null,
      selectedCandidate: activeLpMaintenanceCandidate,
      sessionPhase: sessionActive ? 'active' : 'closed'
    });

    return buildActiveLpMaintenanceContext(
      input,
      input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol),
      sessionActive,
      config.solRouteLimits.maxSlippageBps,
      traderSnapshot,
      activeLpMaintenanceCandidate
    );
  }
  if (input.selectionMode === 'new-open-only') {
    const excludedMints = new Set(resolveOpenCandidateExcludedMints({
      accountState: input.accountState,
      positionState: input.positionState,
      now,
      skipMints: input.skipMints
    }));
    candidates = candidates.filter((candidate) =>
      !candidate.hasInventory &&
      !candidate.hasLpPosition &&
      !excludedMints.has(candidate.mint)
    );
  }
  const newCandidateSafetyMaxBatchSize = Math.max(1, Math.floor(input.newCandidateSafetyMaxBatchSize ?? 1));
  const maxBatchSize = shouldDeferNewCandidateSafety ? 0 : newCandidateSafetyMaxBatchSize;
  const safetyTimeoutMs = typeof input.newCandidateSafetyTimeoutMs === 'number'
    ? Math.max(1_000, input.newCandidateSafetyTimeoutMs)
    : undefined;
  const safetyConfig = input.safetyFilterConfig ?? DEFAULT_SAFETY_CONFIG;
  let safetyDiagnostics: SafetyFilterDiagnostics | null = null;
  candidates = await applySafetyFilter(candidates, {
    safetyConfig,
    maxBatchSize,
    fetchSafety: async (mints) => {
      if (shouldDeferNewCandidateSafety) {
        return buildDeferredSafetyResults(mints);
      }

      return (input.fetchTokenSafetyBatchImpl ?? defaultFetchSafetyBatch(maxBatchSize, safetyTimeoutMs))(mints);
    },
    logger: console,
    onDiagnostics: (diagnostics) => {
      safetyDiagnostics = diagnostics;
    }
  });
  try {
    candidates = await (input.enrichAuxiliarySignalsImpl ?? enrichCandidatesWithAuxiliarySignals)(candidates, {
      config: config.auxiliarySignals,
      logger: console
    });
  } catch (error) {
    console.warn(
      `[Ingest] Auxiliary signal enrichment failed open; continuing without auxiliary signals: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const safeCandidates = candidates;
  const postSafetyCount = safeCandidates.length;
  candidates = filterRecentlyClosedMintCandidates(candidates, {
    lastClosedMint: input.positionState?.lastClosedMint,
    lastClosedAt: input.positionState?.lastClosedAt,
    cooldownMs: RECENTLY_CLOSED_MINT_REOPEN_COOLDOWN_MS,
    now
  });
  candidates = filterOpenCooldownCandidates(candidates, {
    cooldowns: input.openCooldowns,
    now
  });
  const postRecentlyClosedCooldownCount = candidates.length;

  console.log(
    "[Ingest] pools=" + poolRows.length
    + " prefilter=" + prefilteredRows.length
    + " lp=" + preLpCount + "->" + postLpCount
    + " safety=" + postSafetyCount
    + " reopenCooldown=" + postRecentlyClosedCooldownCount
    + " scanWindow=" + inScanWindow
    + " activePositions=" + activePositionsCount
    + " " + formatAuxiliarySignalSummary(candidates)
  );

  const candidate = selectCandidate(candidates, input.strategy, activePositionsCount, maxActivePositions);
  const eligibleSelectionCount = candidates.filter((item) => item.hasInventory || activePositionsCount < maxActivePositions).length;

  if (!candidate) {
    console.log(`[Ingest] No candidate selected: candidates=${candidates.length} eligibleForSelection=${eligibleSelectionCount}`);
  }

  if (!candidate) {
    const diagnostics = resolveNoCandidateBlockReason({
      prefilteredCount: prefilteredRows.length,
      postLpCount,
      postSafetyCount,
      postRecentlyClosedCooldownCount,
      eligibleSelectionCount,
      inScanWindow,
      activePositionsCount,
      safetyDiagnostics
    });

    console.log(`[Ingest] Blocking live cycle: ${diagnostics.blockReason}${diagnostics.blockDetails ? ` (${diagnostics.blockDetails})` : ''}`);

    await appendCandidateScanBestEffort({
      sink: input.candidateScanSink,
      strategy: input.strategy,
      now,
      poolCount: poolRows.length,
      prefilteredCount: prefilteredRows.length,
      postLpCount,
      postSafetyCount,
      postRecentlyClosedCooldownCount,
      eligibleSelectionCount,
      inScanWindow,
      activePositionsCount,
      blockedReason: diagnostics.blockReason,
      allCandidates: prefilterCandidates,
      lpEligibleCandidates,
      safeCandidates,
      safetyDiagnostics,
      selectedCandidate: null,
      sessionPhase: sessionActive ? 'active' : 'closed'
    });

    return buildFallbackContext(
      input,
      input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol),
      sessionActive,
      config.solRouteLimits.maxSlippageBps,
      traderSnapshot,
      diagnostics
    );
  }

  const baseRequestedPositionSol = input.requestedPositionSol ?? defaultRequestedPositionSol(config.live.maxLivePositionSol);
  const requestedPositionSol = resolveCandidateRequestedPositionSol({
    strategy: input.strategy,
    requestedPositionSol: baseRequestedPositionSol,
    candidate,
    disableDynamicPositionSizing: input.disableDynamicPositionSizing
  });
  const lpPositionSignal = resolveLpPositionSignal(input.accountState, {
    mint: candidate.mint,
    poolAddress: candidate.address
  });

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
      feeTvlRatio24h: candidate.feeTvlRatio24h,
      auxSignalScore: candidate.auxSignalScore ?? 0,
      auxSignalStatus: candidate.auxSignalStatus ?? 'disabled'
    },
    token: {
      mint: candidate.mint,
      symbol: candidate.symbol,
      liquidityUsd: candidate.liquidityUsd,
      hasSolRoute: candidate.hasSolRoute,
      inSession: sessionActive,
      holders: candidate.holders,
      expectedOutSol: requestedPositionSol,
      capturedAt: candidate.capturedAt,
      dexscreenerBoostAmount: candidate.dexscreenerBoostAmount ?? 0,
      dexscreenerHasProfile: candidate.dexscreenerHasProfile ?? false,
      jupiterOrganicScore: candidate.jupiterOrganicScore ?? 0,
      jupiterTrendingRank: candidate.jupiterTrendingRank ?? 0,
      coingeckoTrendingRank: candidate.coingeckoTrendingRank ?? 0
    },
    trader: {
      wallet: input.traderWallet ?? '',
      hasInventory: candidate.hasInventory,
      hasLpPosition: candidate.hasLpPosition,
      ...buildLpSignalTraderFields(lpPositionSignal),
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

  await appendCandidateScanBestEffort({
    sink: input.candidateScanSink,
    strategy: input.strategy,
    now,
    poolCount: poolRows.length,
    prefilteredCount: prefilteredRows.length,
    postLpCount,
    postSafetyCount,
    postRecentlyClosedCooldownCount,
    eligibleSelectionCount,
    inScanWindow,
    activePositionsCount,
    allCandidates: prefilterCandidates,
    lpEligibleCandidates,
    safeCandidates,
    safetyDiagnostics,
    selectedCandidate: candidate,
    sessionPhase: sessionActive ? 'active' : 'closed'
  });

  const evolutionWatchlistCandidates = buildCandidateScanRecords({
    strategy: input.strategy,
    capturedAt: now.toISOString(),
    activePositionsCount,
    sessionPhase: sessionActive ? 'active' : 'closed',
    allCandidates: prefilterCandidates,
    lpEligibleCandidates,
    safeCandidates,
    safetyDiagnostics,
    selectedCandidate: candidate
  }).map((candidateRecord) => ({
    tokenMint: candidateRecord.tokenMint,
    tokenSymbol: candidateRecord.tokenSymbol,
    poolAddress: candidateRecord.poolAddress,
    sourceReason: candidateRecord.selected ? 'selected' : 'filtered_out',
    trackedSince: candidateRecord.capturedAt
  }));

  return {
    context,
    requestedPositionSol,
    sessionPhase: sessionActive ? 'active' : 'closed',
    evolutionWatchlistCandidates
  };
}

function defaultFetchSafetyBatch(maxBatchSize: number, timeoutMs?: number) {
  return async (mints: string[]) =>
    fetchTokenSafetyBatch(mints, { maxBatchSize, timeoutMs });
}
