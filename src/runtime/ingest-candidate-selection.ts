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
import { evaluateDlmmPool } from '../strategy/filtering/dlmm-pool-filter.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export type IngestCandidate = {
  address: string;
  mint: string;
  symbol: string;
  quoteMint: string;
  liquidityUsd: number;
  hasSolRoute: boolean;
  capturedAt: string;
  holders: number;
  momentum: number;
  hasInventory: boolean;
  score: number;
  binStep: number;
  baseFeePct: number;
  volume24h: number;
  feeTvlRatio24h: number;
  safetyScore?: number;
};

export function countActiveInventoryPositions(accountState: LiveAccountState | undefined) {
  return (accountState?.walletTokens ?? [])
    .filter((token) => token.amount > 0 && token.symbol !== 'SOL' && token.mint !== SOL_MINT)
    .length;
}

export function isInScanWindow(now: Date) {
  const currentMinute = now.getMinutes();
  return (currentMinute >= 0 && currentMinute <= 10) || (currentMinute >= 30 && currentMinute <= 40);
}

export function selectCandidate(
  candidates: IngestCandidate[],
  strategy: StrategyId,
  inScanWindow: boolean,
  activePositionsCount: number
) {
  void inScanWindow;

  const filtered = candidates.filter((candidate) => {
    if (candidate.address.length === 0 || candidate.symbol.length === 0) {
      return false;
    }

    if (!candidate.hasInventory && activePositionsCount >= 5) {
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
      if (rightSafety !== leftSafety) {
        return rightSafety - leftSafety;
      }

      if (right.feeTvlRatio24h !== left.feeTvlRatio24h) {
        return right.feeTvlRatio24h - left.feeTvlRatio24h;
      }
    }

    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return right.liquidityUsd - left.liquidityUsd;
  });

  return filtered[0] ?? null;
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

  const solMints = candidates.filter((candidate) => candidate.hasSolRoute).map((candidate) => candidate.mint).filter(Boolean);
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

    const filtered = candidates
      .filter((candidate) => safeMap.has(candidate.mint))
      .map((candidate) => ({
        ...candidate,
        safetyScore: (safeMap.get(candidate.mint) ?? 0) + resolveFeeTvlBonus(candidate.feeTvlRatio24h)
      }));

    const rejected = candidates
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
      `[Ingest] Safety filter: ${candidates.length} -> ${filtered.length} safe candidates (${uniqueMints.length} unique SOL pairs checked, maxBatchSize=${options.maxBatchSize})`
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
    options.logger?.warn(
      `[Ingest] Safety filter failed, preserving ${candidates.length} original candidates: ${error instanceof Error ? error.message : String(error)}`
    );
    options.onDiagnostics?.({
      checkedMints: uniqueMints,
      results: [],
      rejected: []
    });
    return candidates;
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
