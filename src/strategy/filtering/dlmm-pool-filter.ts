const SOL_MINT = 'So11111111111111111111111111111111111111112';

export type DlmmPoolCandidate = {
  address: string;
  name: string;
  tokenXMint: string;
  tokenXSymbol: string;
  tokenYMint: string;
  tokenYSymbol: string;
  binStep: number;
  baseFeePct: number;
  tvl: number;
  volume24h: number;
  feeTvlRatio24h: number;
  isBlacklisted: boolean;
};

export type DlmmPoolFilterConfig = {
  /** Minimum bin step (default 100 for volatile pairs) */
  minBinStep: number;
  /** Minimum TVL in USD */
  minTvlUsd: number;
  /** Minimum 24h volume in USD */
  minVolume24hUsd: number;
  /** Minimum 24h fee/tvl ratio (0 = no filter) */
  minFeeTvlRatio24h: number;
};

export type DlmmFilterResult = {
  accepted: boolean;
  reasons: string[];
};

/** Check whether the pool is SOL-paired (SOL on either side) */
export function isSolPaired(candidate: DlmmPoolCandidate): boolean {
  return candidate.tokenXMint === SOL_MINT || candidate.tokenYMint === SOL_MINT;
}

/** Return the non-SOL token symbol from a SOL-paired pool */
export function getNonSolSymbol(candidate: DlmmPoolCandidate): string {
  if (candidate.tokenXMint === SOL_MINT) {
    return candidate.tokenYSymbol;
  }

  return candidate.tokenXSymbol;
}

/** Return the non-SOL token mint from a SOL-paired pool */
export function getNonSolMint(candidate: DlmmPoolCandidate): string {
  if (candidate.tokenXMint === SOL_MINT) {
    return candidate.tokenYMint;
  }

  return candidate.tokenXMint;
}

/** Evaluate a single DLMM pool against filter criteria */
export function evaluateDlmmPool(
  candidate: DlmmPoolCandidate,
  config: DlmmPoolFilterConfig
): DlmmFilterResult {
  const reasons: string[] = [];

  if (candidate.isBlacklisted) {
    reasons.push('blacklisted');
  }

  if (!isSolPaired(candidate)) {
    reasons.push('not-sol-paired');
  }

  if (candidate.binStep < config.minBinStep) {
    reasons.push('bin-step-too-low');
  }

  if (candidate.tvl < config.minTvlUsd) {
    reasons.push('insufficient-tvl');
  }

  if (candidate.volume24h < config.minVolume24hUsd) {
    reasons.push('insufficient-volume');
  }

  if (
    config.minFeeTvlRatio24h > 0 &&
    candidate.feeTvlRatio24h < config.minFeeTvlRatio24h
  ) {
    reasons.push('low-fee-tvl-ratio');
  }

  return {
    accepted: reasons.length === 0,
    reasons
  };
}

/**
 * Deduplicate pools by non-SOL token: keep the pool with the highest TVL
 * for each unique token.
 */
export function deduplicateByToken(
  candidates: DlmmPoolCandidate[]
): DlmmPoolCandidate[] {
  const byMint = new Map<string, DlmmPoolCandidate>();

  for (const candidate of candidates) {
    const mint = getNonSolMint(candidate);
    const existing = byMint.get(mint);

    if (!existing || candidate.tvl > existing.tvl) {
      byMint.set(mint, candidate);
    }
  }

  return [...byMint.values()];
}

/**
 * Full pipeline: filter → deduplicate → sort by TVL descending.
 */
export function selectDlmmPools(
  candidates: DlmmPoolCandidate[],
  config: DlmmPoolFilterConfig
): DlmmPoolCandidate[] {
  const accepted = candidates.filter(
    (candidate) => evaluateDlmmPool(candidate, config).accepted
  );

  const deduped = deduplicateByToken(accepted);

  return deduped.sort((a, b) => b.tvl - a.tvl);
}
