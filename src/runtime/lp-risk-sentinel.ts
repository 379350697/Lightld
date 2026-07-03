export type LpRiskIntent = 'hold' | 'range-warning' | 'range-exit' | 'liquidity-exit' | 'volatility-exit';

export type LpOutOfRangeSide = 'below' | 'above';

const DEFAULT_ABOVE_OUT_OF_RANGE_EXIT_BINS = 8;

export type LpRiskSentinelSnapshot = {
  observedAt: string;
  riskIntent: LpRiskIntent;
  riskReason: string;
  activeBinId?: number;
  lowerBinId?: number;
  upperBinId?: number;
  activeBinDistanceToLower?: number;
  activeBinDistanceToUpper?: number;
  outOfRangeSide?: LpOutOfRangeSide;
  outOfRangeBins?: number;
  solDepletedBins?: number;
  binCount?: number;
  solDepletionExitBins?: number;
  solDepletedRatio?: number;
  currentValueSol?: number;
  liquidityValueSol?: number;
  poolLiquidityUsd?: number;
  tokenMarketCapUsd?: number;
  tokenPriceUsd?: number;
  currentPrice?: number;
};

type Numeric = number | undefined;

export type LpRiskSentinelInput = {
  observedAt?: string;
  activeBinId?: Numeric;
  lowerBinId?: Numeric;
  upperBinId?: Numeric;
  solDepletedBins?: Numeric;
  binCount?: Numeric;
  solDepletionExitBins?: Numeric;
  currentValueSol?: Numeric;
  liquidityValueSol?: Numeric;
  poolLiquidityUsd?: Numeric;
  tokenMarketCapUsd?: Numeric;
  tokenPriceUsd?: Numeric;
  currentPrice?: Numeric;
  previous?: LpRiskSentinelSnapshot;
  warningDistanceBins?: number;
  aboveOutOfRangeExitBins?: number;
  liquidityDropPct?: number;
  valueDropPct?: number;
  priceDropPct?: number;
  marketCapDropPct?: number;
};

function finite(value: Numeric) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pctDrop(previous: Numeric, current: Numeric) {
  const prev = finite(previous);
  const next = finite(current);
  if (typeof prev !== 'number' || prev <= 0 || typeof next !== 'number') {
    return undefined;
  }

  return ((prev - next) / prev) * 100;
}

function isAtOrAboveDrop(previous: Numeric, current: Numeric, thresholdPct: number) {
  const dropPct = pctDrop(previous, current);
  return typeof dropPct === 'number' && dropPct >= thresholdPct;
}

function buildBaseSnapshot(input: LpRiskSentinelInput): LpRiskSentinelSnapshot {
  const activeBinId = finite(input.activeBinId);
  const lowerBinId = finite(input.lowerBinId);
  const upperBinId = finite(input.upperBinId);
  const solDepletedBins = finite(input.solDepletedBins);
  const binCount = finite(input.binCount);
  const solDepletionExitBins = finite(input.solDepletionExitBins) ?? 60;
  const solDepletedRatio = typeof solDepletedBins === 'number' && typeof binCount === 'number' && binCount > 0
    ? solDepletedBins / binCount
    : undefined;
  const activeBinDistanceToLower = typeof activeBinId === 'number' && typeof lowerBinId === 'number'
    ? activeBinId - lowerBinId
    : undefined;
  const activeBinDistanceToUpper = typeof activeBinId === 'number' && typeof upperBinId === 'number'
    ? upperBinId - activeBinId
    : undefined;
  const outOfRangeSide = typeof activeBinId === 'number' && typeof lowerBinId === 'number' && activeBinId < lowerBinId
    ? 'below' as const
    : typeof activeBinId === 'number' && typeof upperBinId === 'number' && activeBinId > upperBinId
      ? 'above' as const
      : undefined;
  const outOfRangeBins = outOfRangeSide === 'below' && typeof activeBinId === 'number' && typeof lowerBinId === 'number'
    ? lowerBinId - activeBinId
    : outOfRangeSide === 'above' && typeof activeBinId === 'number' && typeof upperBinId === 'number'
      ? activeBinId - upperBinId
      : undefined;

  return {
    observedAt: input.observedAt ?? new Date().toISOString(),
    riskIntent: 'hold',
    riskReason: 'lp-risk-sentinel-hold',
    activeBinId,
    lowerBinId,
    upperBinId,
    activeBinDistanceToLower,
    activeBinDistanceToUpper,
    outOfRangeSide,
    outOfRangeBins,
    solDepletedBins,
    binCount,
    solDepletionExitBins,
    solDepletedRatio,
    currentValueSol: finite(input.currentValueSol),
    liquidityValueSol: finite(input.liquidityValueSol),
    poolLiquidityUsd: finite(input.poolLiquidityUsd),
    tokenMarketCapUsd: finite(input.tokenMarketCapUsd),
    tokenPriceUsd: finite(input.tokenPriceUsd),
    currentPrice: finite(input.currentPrice)
  };
}

export function evaluateLpRiskSentinel(input: LpRiskSentinelInput): LpRiskSentinelSnapshot {
  const snapshot = buildBaseSnapshot(input);
  const warningDistanceBins = Math.max(0, input.warningDistanceBins ?? 3);
  const aboveOutOfRangeExitBins = Math.max(0, input.aboveOutOfRangeExitBins ?? DEFAULT_ABOVE_OUT_OF_RANGE_EXIT_BINS);

  if (snapshot.outOfRangeSide && typeof snapshot.outOfRangeBins === 'number' && snapshot.outOfRangeBins > 0) {
    if (snapshot.outOfRangeSide === 'above' && snapshot.outOfRangeBins <= aboveOutOfRangeExitBins) {
      return {
        ...snapshot,
        riskIntent: 'range-warning',
        riskReason: `active-bin-out-of-range:above-within-tolerance:${snapshot.outOfRangeBins}/${aboveOutOfRangeExitBins}`
      };
    }

    return {
      ...snapshot,
      riskIntent: 'range-exit',
      riskReason: `active-bin-out-of-range:${snapshot.outOfRangeSide}:${snapshot.outOfRangeBins}`
    };
  }

  if (
    typeof snapshot.solDepletedBins === 'number' &&
    typeof snapshot.solDepletionExitBins === 'number' &&
    snapshot.solDepletedBins >= snapshot.solDepletionExitBins
  ) {
    return {
      ...snapshot,
      riskIntent: 'range-exit',
      riskReason: `sol-depleted-bins:${snapshot.solDepletedBins}/${typeof snapshot.binCount === 'number' ? snapshot.binCount : 'unknown'}:threshold=${snapshot.solDepletionExitBins}`
    };
  }

  if (
    typeof snapshot.activeBinDistanceToLower === 'number' &&
    typeof snapshot.activeBinDistanceToUpper === 'number' &&
    Math.min(snapshot.activeBinDistanceToLower, snapshot.activeBinDistanceToUpper) <= warningDistanceBins
  ) {
    snapshot.riskIntent = 'range-warning';
    snapshot.riskReason = `active-bin-near-range-edge:${Math.min(snapshot.activeBinDistanceToLower, snapshot.activeBinDistanceToUpper)}`;
  }

  const previous = input.previous;
  if (!previous) {
    return snapshot;
  }

  if (
    isAtOrAboveDrop(previous.poolLiquidityUsd, snapshot.poolLiquidityUsd, input.liquidityDropPct ?? 35) ||
    isAtOrAboveDrop(previous.liquidityValueSol, snapshot.liquidityValueSol, input.valueDropPct ?? 35)
  ) {
    return {
      ...snapshot,
      riskIntent: 'liquidity-exit',
      riskReason: 'liquidity-drop'
    };
  }

  if (
    isAtOrAboveDrop(previous.tokenMarketCapUsd, snapshot.tokenMarketCapUsd, input.marketCapDropPct ?? 25) ||
    isAtOrAboveDrop(previous.tokenPriceUsd, snapshot.tokenPriceUsd, input.priceDropPct ?? 25) ||
    isAtOrAboveDrop(previous.currentPrice, snapshot.currentPrice, input.priceDropPct ?? 25)
  ) {
    return {
      ...snapshot,
      riskIntent: 'volatility-exit',
      riskReason: 'price-or-market-cap-drop'
    };
  }

  return snapshot;
}
