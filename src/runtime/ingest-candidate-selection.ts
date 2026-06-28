import type {
  TokenSafetyConfig,
  TokenSafetyResult
} from '../ingest/gmgn/token-safety-client.ts';
import { isTokenSafe } from '../ingest/gmgn/token-safety-client.ts';

export type SafetyFilterDiagnostics = {
  checkedMints: string[];
  results: TokenSafetyResult[];
  rejected: Array<{
    symbol: string;
    mint: string;
    rejectReasons: string[];
    safetyScore: number;
    error?: string;
  }>;
};
import type { LiveAccountState } from './live-account-provider.ts';
import type { StrategyId } from './live-cycle.ts';
import type { StrategyConfig } from '../config/schema.ts';
import type { AuxiliarySignalFields } from '../ingest/signals/types.ts';
import { evaluateDlmmPool } from '../strategy/filtering/dlmm-pool-filter.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);

export const RECENTLY_CLOSED_MINT_REOPEN_COOLDOWN_MS = 50 * 60 * 1000;

function hasActiveLpLiquidity(position: { hasLiquidity?: boolean }) {
  return position.hasLiquidity ?? true;
}

export type IngestCandidate = {
  address: string;
  mint: string;
  symbol: string;
  chain?: string;
  quoteMint: string;
  liquidityUsd: number;
  hasSolRoute: boolean;
  capturedAt: string;
  holders: number;
  hasInventory: boolean;
  hasLpPosition: boolean;
  binStep: number;
  baseFeePct: number;
  volume24h: number;
  feeTvlRatio24h: number;
  poolFeeYieldStatus?: string;
  poolFeeYieldScore?: number;
  poolFeeYieldReason?: string;
  netFeeUsd1h?: number;
  netFeeYield30m?: number;
  netFeeYield1h?: number;
  netFeeYield2h?: number;
  netFeeYield4h?: number;
  tvlChange1hPct?: number | null;
  feeYieldObservedAt?: string;
  safetyScore?: number;
} & Partial<AuxiliarySignalFields>;

export function countActiveInventoryPositions(accountState: LiveAccountState | undefined) {
  const inventoryPositions = (accountState?.walletTokens ?? [])
    .filter((token) => token.amount > 0 && token.symbol !== 'SOL' && token.mint !== SOL_MINT && !STABLE_MINTS.has(token.mint))
    .length;
  const lpPositions = (accountState?.walletLpPositions ?? [])
    .filter((position) => hasActiveLpLiquidity(position) && position.mint !== SOL_MINT && !STABLE_MINTS.has(position.mint))
    .length;

  return inventoryPositions + lpPositions;
}

export function isInScanWindow(now: Date) {
  const currentMinute = now.getMinutes();
  return (currentMinute >= 0 && currentMinute <= 10) || (currentMinute >= 30 && currentMinute <= 40);
}

export function filterRecentlyClosedMintCandidates(
  candidates: IngestCandidate[],
  options: {
    lastClosedMint?: string;
    lastClosedAt?: string;
    cooldownMs?: number;
    now?: Date;
  }
) {
  const lastClosedMint = options.lastClosedMint ?? '';
  const lastClosedAt = options.lastClosedAt ?? '';
  const cooldownMs = options.cooldownMs ?? RECENTLY_CLOSED_MINT_REOPEN_COOLDOWN_MS;
  const closedAtMs = Date.parse(lastClosedAt);
  const nowMs = (options.now ?? new Date()).getTime();

  if (!lastClosedMint || !Number.isFinite(closedAtMs) || nowMs - closedAtMs >= cooldownMs) {
    return candidates;
  }

  return candidates.filter((candidate) =>
    candidate.mint !== lastClosedMint || candidate.hasInventory || candidate.hasLpPosition
  );
}

export function selectCandidate(
  candidates: IngestCandidate[],
  strategy: StrategyId,
  activePositionsCount: number,
  maxActivePositions = 5
) {
  const filtered = candidates.filter((candidate) => {
    if (candidate.address.length === 0 || candidate.symbol.length === 0) {
      return false;
    }

    if (!candidate.hasInventory && activePositionsCount >= maxActivePositions) {
      return false;
    }

    return true;
  });

  if (filtered.length === 0) {
    return null;
  }

  filtered.sort((left, right) => {
    if (strategy === 'new-token-v1') {
      if (left.hasInventory !== right.hasInventory) {
        return Number(right.hasInventory) - Number(left.hasInventory);
      }

      const leftSafety = left.safetyScore ?? 0;
      const rightSafety = right.safetyScore ?? 0;
      const leftSelectionScore = resolveNewTokenSelectionScore(left);
      const rightSelectionScore = resolveNewTokenSelectionScore(right);
      if (rightSelectionScore !== leftSelectionScore) {
        return rightSelectionScore - leftSelectionScore;
      }

      if (rightSafety !== leftSafety) {
        return rightSafety - leftSafety;
      }

      if (right.feeTvlRatio24h !== left.feeTvlRatio24h) {
        return right.feeTvlRatio24h - left.feeTvlRatio24h;
      }
    }

    const leftSafety = left.safetyScore ?? 0;
    const rightSafety = right.safetyScore ?? 0;
    if (rightSafety !== leftSafety) {
      return rightSafety - leftSafety;
    }

    return right.liquidityUsd - left.liquidityUsd;
  });

  return filtered[0] ?? null;
}

function resolveNewTokenSelectionScore(candidate: IngestCandidate) {
  return (candidate.safetyScore ?? 0) + (candidate.auxSignalScore ?? 0);
}

export function filterLpEligibleCandidates(
  candidates: IngestCandidate[],
  config: StrategyConfig
) {
  const lpConfig = config.lpConfig;

  if (config.poolClass !== 'new-token' || !lpConfig?.enabled) {
    return candidates;
  }

  return candidates.filter((candidate) => {
    if (candidate.hasInventory) {
      return true;
    }

    return evaluateDlmmPool({
      address: candidate.address,
      name: `${candidate.symbol}-SOL`,
      tokenXMint: candidate.mint,
      tokenXSymbol: candidate.symbol,
      tokenYMint: candidate.quoteMint,
      tokenYSymbol: 'SOL',
      binStep: candidate.binStep,
      baseFeePct: candidate.baseFeePct,
      tvl: candidate.liquidityUsd,
      volume24h: candidate.volume24h,
      feeTvlRatio24h: candidate.feeTvlRatio24h,
      isBlacklisted: false
    }, {
      minBinStep: lpConfig.minBinStep,
      minTvlUsd: config.filters.minLiquidityUsd,
      minVolume24hUsd: lpConfig.minVolume24hUsd,
      minFeeTvlRatio24h: lpConfig.minFeeTvlRatio24h
    }).accepted;
  });
}

export function rankCandidatesForSafety(candidates: IngestCandidate[]) {
  return [...candidates].sort((left, right) => {
    if (left.hasInventory !== right.hasInventory) {
      return Number(right.hasInventory) - Number(left.hasInventory);
    }

    if (left.hasLpPosition !== right.hasLpPosition) {
      return Number(right.hasLpPosition) - Number(left.hasLpPosition);
    }

    if (right.feeTvlRatio24h !== left.feeTvlRatio24h) {
      return right.feeTvlRatio24h - left.feeTvlRatio24h;
    }

    if (right.liquidityUsd !== left.liquidityUsd) {
      return right.liquidityUsd - left.liquidityUsd;
    }

    const rightAge = Date.parse(right.capturedAt) || 0;
    const leftAge = Date.parse(left.capturedAt) || 0;
    if (rightAge !== leftAge) {
      return leftAge - rightAge;
    }

    if (right.volume24h !== left.volume24h) {
      return right.volume24h - left.volume24h;
    }

    return right.liquidityUsd - left.liquidityUsd;
  });
}

export async function applySafetyFilter(
  candidates: IngestCandidate[],
  options: {
    safetyConfig: TokenSafetyConfig;
    maxBatchSize: number;
    fetchSafety(mints: string[]): Promise<TokenSafetyResult[]>;
    logger?: Pick<Console, 'log' | 'warn'>;
    onDiagnostics?(diagnostics: SafetyFilterDiagnostics): void;
  }
) {
  if (options.safetyConfig.disabled) {
    options.onDiagnostics?.({
      checkedMints: [],
      results: [],
      rejected: []
    });
    return candidates;
  }

  const existingExposureCandidates = candidates.filter((candidate) => candidate.hasInventory || candidate.hasLpPosition);
  const newEntryCandidates = candidates.filter((candidate) => !candidate.hasInventory && !candidate.hasLpPosition);
  const solMints = newEntryCandidates.filter((candidate) => candidate.hasSolRoute).map((candidate) => candidate.mint).filter(Boolean);
  const uniqueMints = [...new Set(solMints)];

  if (uniqueMints.length === 0) {
    options.onDiagnostics?.({
      checkedMints: [],
      results: [],
      rejected: []
    });
    return candidates;
  }

  try {
    const safetyResults = await options.fetchSafety(uniqueMints);
    const safeMap = new Map<string, number>();

    for (const result of safetyResults) {
      if (isTokenSafe(result, options.safetyConfig)) {
        safeMap.set(result.mint, result.safetyScore);
      }
    }

    const filteredNewEntries = newEntryCandidates
      .filter((candidate) => safeMap.has(candidate.mint))
      .map((candidate) => ({
        ...candidate,
        safetyScore: (safeMap.get(candidate.mint) ?? 0) + resolveFeeTvlBonus(candidate.feeTvlRatio24h)
      }));
    const filtered = [
      ...existingExposureCandidates,
      ...filteredNewEntries
    ];

    const rejected = newEntryCandidates
      .filter((candidate) => !safeMap.has(candidate.mint))
      .map((candidate) => {
        const result = safetyResults.find((item) => item.mint === candidate.mint);
        return {
          symbol: candidate.symbol,
          mint: candidate.mint,
          rejectReasons: result?.rejectReasons ?? [],
          safetyScore: result?.safetyScore ?? 0,
          error: result?.error
        };
      });

    options.logger?.log(
      `[Ingest] Safety filter: ${candidates.length} -> ${filtered.length} candidates (newEntries=${newEntryCandidates.length}, existingExposureBypassed=${existingExposureCandidates.length}, unique SOL pairs checked=${uniqueMints.length}, maxBatchSize=${options.maxBatchSize})`
    );

    if (rejected.length > 0) {
      options.logger?.log(`[Ingest] Safety rejected: ${JSON.stringify(rejected)}`);
    }

    options.onDiagnostics?.({
      checkedMints: uniqueMints,
      results: safetyResults,
      rejected
    });

    return filtered;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedResults = uniqueMints.map((mint) => ({
      mint,
      safe: false,
      safetyScore: 0,
      maxScore: 120,
      error: message
    } satisfies TokenSafetyResult));
    const rejected = newEntryCandidates
      .filter((candidate) => uniqueMints.includes(candidate.mint))
      .map((candidate) => ({
        symbol: candidate.symbol,
        mint: candidate.mint,
        rejectReasons: [],
        safetyScore: 0,
        error: message
      }));

    options.logger?.warn(
      `[Ingest] Safety filter failed closed for ${newEntryCandidates.length} new-entry candidates; keeping ${existingExposureCandidates.length} existing-exposure candidates: ${message}`
    );
    options.onDiagnostics?.({
      checkedMints: uniqueMints,
      results: failedResults,
      rejected
    });
    return existingExposureCandidates;
  }
}

function resolveFeeTvlBonus(feeTvlRatio24h: number) {
  if (feeTvlRatio24h > 0.20) {
    return 40;
  }

  if (feeTvlRatio24h >= 0.10) {
    return 30;
  }

  if (feeTvlRatio24h >= 0.05) {
    return 20;
  }

  return 0;
}
