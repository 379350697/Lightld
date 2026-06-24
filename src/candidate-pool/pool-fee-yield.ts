import type { IngestCandidate } from '../runtime/ingest-candidate-selection.ts';
import type { StrategyId } from '../runtime/live-cycle.ts';
import type { CandidateSourceObservation } from './types.ts';

export const POOL_FEE_YIELD_WINDOWS = ['30m', '1h', '2h', '4h', '12h', '24h'] as const;

export type PoolFeeYieldWindow = (typeof POOL_FEE_YIELD_WINDOWS)[number];

export type PoolFeeYieldStatus =
  | 'ready'
  | 'liquidity_drain_watch'
  | 'retired_liquidity_drain'
  | 'denominator_fake_yield'
  | 'yield_profile_missing'
  | 'source_unavailable';

export type PoolFeeYieldSample = {
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  observedAt: string;
  tvlUsd: number;
  dynamicFeePct: number;
  feesUsd: Record<PoolFeeYieldWindow, number>;
  protocolFeesUsd: Record<PoolFeeYieldWindow, number>;
  netFeesUsd: Record<PoolFeeYieldWindow, number>;
  netFeeYield: Record<PoolFeeYieldWindow, number>;
  volumeUsd: Record<PoolFeeYieldWindow, number>;
  rawJson: Record<string, unknown>;
};

export type PoolFeeYieldProfile = {
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  observedAt: string;
  status: PoolFeeYieldStatus;
  score: number;
  reason: string;
  tvlUsd: number;
  tvlChange1hPct: number | null;
  netFeeUsd1h: number;
  netFeeYield30m: number;
  netFeeYield1h: number;
  netFeeYield2h: number;
  netFeeYield4h: number;
  currentYield1h: number;
  prevHourYield: number;
  recent30mYield: number;
  prev30mYield: number;
  fakeYieldReason: string;
  retiredUntil?: string;
};

export type PoolFeeYieldStore = {
  recordPoolFeeYieldSamples(input: {
    strategyId: StrategyId;
    rows: Record<string, unknown>[];
    observedAt: Date;
    sampleIntervalMs?: number;
    minTvlUsd?: number;
    retirementMs?: number;
    retentionMs?: number;
  }): Promise<Map<string, PoolFeeYieldProfile>>;
};

const ZERO_WINDOWS = Object.freeze({
  '30m': 0,
  '1h': 0,
  '2h': 0,
  '4h': 0,
  '12h': 0,
  '24h': 0
} satisfies Record<PoolFeeYieldWindow, number>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

function resolveNestedString(
  record: Record<string, unknown>,
  objectKeys: string[],
  fieldKeys: string[]
) {
  for (const objectKey of objectKeys) {
    const nested = record[objectKey];
    if (!isRecord(nested)) {
      continue;
    }
    const value = readString(nested, fieldKeys);
    if (value) {
      return value;
    }
  }
  return '';
}

function windowNumbers(raw: unknown, flatPrefix: string) {
  const record = isRecord(raw) ? raw : {};
  const values = { ...ZERO_WINDOWS };
  for (const window of POOL_FEE_YIELD_WINDOWS) {
    values[window] = readNumber(record, [window])
      || readNumber(record, [window.replace('m', 'min')])
      || 0;
  }
  return (payload: Record<string, unknown>) => {
    const resolved = { ...values };
    for (const window of POOL_FEE_YIELD_WINDOWS) {
      resolved[window] ||= readNumber(payload, [
        `${flatPrefix}_${window}`,
        `${flatPrefix}${window.replace(/(^|[^a-z0-9])([a-z0-9])/g, (_match, _prefix, char) => String(char).toUpperCase())}`
      ]);
    }
    return resolved;
  };
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

export function parseMeteoraPoolFeeYieldSample(
  row: Record<string, unknown>,
  observedAt: Date
): PoolFeeYieldSample | null {
  const tokenX = isRecord(row.token_x) ? row.token_x : {};
  const tokenY = isRecord(row.token_y) ? row.token_y : {};
  const tokenXMint = readString(row, ['baseMint', 'base_mint', 'mint', 'token_x_mint'])
    || readString(tokenX, ['address', 'mint']);
  const tokenXSymbol = readString(row, ['baseSymbol', 'base_symbol', 'symbol', 'token_x_symbol'])
    || readString(tokenX, ['symbol']);
  const tokenYMint = readString(row, ['quoteMint', 'quote_mint', 'token_y_mint'])
    || readString(tokenY, ['address', 'mint']);
  const tokenYSymbol = readString(row, ['quoteSymbol', 'quote_symbol', 'token_y_symbol'])
    || readString(tokenY, ['symbol']);
  const solMint = 'So11111111111111111111111111111111111111112';
  const tokenMint = tokenXMint === solMint ? tokenYMint : tokenXMint;
  const tokenSymbol = tokenXMint === solMint ? tokenYSymbol : tokenXSymbol;
  const poolAddress = readString(row, ['address', 'poolAddress', 'pool_address']);
  const tvlUsd = readNumber(row, ['tvl', 'liquidityUsd', 'liquidity', 'tvlUsd']);

  if (!poolAddress || !tokenMint || !tokenSymbol || tvlUsd <= 0) {
    return null;
  }

  const feesUsd = windowNumbers(row.fees, 'fees')(row);
  const protocolFeesUsd = windowNumbers(row.protocol_fees, 'protocol_fees')(row);
  const volumeUsd = windowNumbers(row.volume, 'volume')(row);
  const netFeesUsd = { ...ZERO_WINDOWS };
  const netFeeYield = { ...ZERO_WINDOWS };

  for (const window of POOL_FEE_YIELD_WINDOWS) {
    netFeesUsd[window] = Math.max(0, feesUsd[window] - protocolFeesUsd[window]);
    netFeeYield[window] = tvlUsd > 0 ? netFeesUsd[window] / tvlUsd : 0;
  }

  return {
    poolAddress,
    tokenMint,
    tokenSymbol,
    observedAt: observedAt.toISOString(),
    tvlUsd,
    dynamicFeePct: readNumber(row, ['dynamic_fee_pct', 'dynamicFeePct']),
    feesUsd,
    protocolFeesUsd,
    netFeesUsd,
    netFeeYield,
    volumeUsd,
    rawJson: row
  };
}

export function buildPoolFeeYieldProfile(input: {
  sample: PoolFeeYieldSample;
  previousTvlUsd?: number | null;
  minTvlUsd?: number;
  retirementMs?: number;
}): PoolFeeYieldProfile {
  const minTvlUsd = input.minTvlUsd ?? 1_000;
  const sample = input.sample;
  const previousTvlUsd = input.previousTvlUsd ?? null;
  const tvlChange1hPct = previousTvlUsd && previousTvlUsd > 0
    ? (sample.tvlUsd - previousTvlUsd) / previousTvlUsd
    : null;
  const prevHourNetFeeUsd = Math.max(0, sample.netFeesUsd['2h'] - sample.netFeesUsd['1h']);
  const prevHourYield = sample.tvlUsd > 0 ? prevHourNetFeeUsd / sample.tvlUsd : 0;
  const prev30mNetFeeUsd = Math.max(0, sample.netFeesUsd['1h'] - sample.netFeesUsd['30m']);
  const prev30mYield = sample.tvlUsd > 0 ? prev30mNetFeeUsd / sample.tvlUsd : 0;
  const currentYield1h = sample.netFeeYield['1h'];
  const recent30mYield = sample.netFeeYield['30m'];
  const continuityYield = sample.netFeeYield['4h'] / 4;
  const hasDrainWatch = tvlChange1hPct !== null && tvlChange1hPct <= -0.35;
  const hasRetiredDrain = sample.tvlUsd < minTvlUsd || (tvlChange1hPct !== null && tvlChange1hPct <= -0.50);
  const denominatorFakeYield = hasDrainWatch
    && currentYield1h > Math.max(prevHourYield * 1.25, 0.0005)
    && sample.netFeesUsd['1h'] <= Math.max(prevHourNetFeeUsd * 1.50, 5);
  const lowAbsoluteFee = sample.netFeesUsd['1h'] < 10;

  let score = clamp(currentYield1h * 10_000, 0, 60);
  if (recent30mYield > prev30mYield && prev30mYield > 0) {
    score += clamp(((recent30mYield / prev30mYield) - 1) * 10, 0, 20);
  }
  if (currentYield1h > prevHourYield && prevHourYield > 0) {
    score += clamp(((currentYield1h / prevHourYield) - 1) * 8, 0, 15);
  }
  if (continuityYield > 0 && currentYield1h >= continuityYield * 0.75) {
    score += 10;
  }
  if (lowAbsoluteFee) {
    score = Math.min(score, 10);
  }
  if (hasDrainWatch) {
    score *= 0.35;
  }

  let status: PoolFeeYieldStatus = 'ready';
  let reason = 'fee-yield-ready';
  let fakeYieldReason = '';
  let retiredUntil: string | undefined;

  if (hasRetiredDrain) {
    status = 'retired_liquidity_drain';
    reason = sample.tvlUsd < minTvlUsd ? 'tvl-below-minimum' : 'tvl-dropped-more-than-50pct';
    retiredUntil = new Date(Date.parse(sample.observedAt) + (input.retirementMs ?? 6 * 60 * 60 * 1000)).toISOString();
    score = 0;
  } else if (denominatorFakeYield) {
    status = 'denominator_fake_yield';
    reason = 'fee-yield-ratio-increased-from-liquidity-drain';
    fakeYieldReason = reason;
    score = 0;
  } else if (hasDrainWatch) {
    status = 'liquidity_drain_watch';
    reason = 'tvl-dropped-more-than-35pct';
    score = 0;
  } else if (lowAbsoluteFee) {
    reason = 'low-absolute-net-fee';
  }

  return {
    poolAddress: sample.poolAddress,
    tokenMint: sample.tokenMint,
    tokenSymbol: sample.tokenSymbol,
    observedAt: sample.observedAt,
    status,
    score: Number(score.toFixed(6)),
    reason,
    tvlUsd: sample.tvlUsd,
    tvlChange1hPct,
    netFeeUsd1h: sample.netFeesUsd['1h'],
    netFeeYield30m: sample.netFeeYield['30m'],
    netFeeYield1h: sample.netFeeYield['1h'],
    netFeeYield2h: sample.netFeeYield['2h'],
    netFeeYield4h: sample.netFeeYield['4h'],
    currentYield1h,
    prevHourYield,
    recent30mYield,
    prev30mYield,
    fakeYieldReason,
    retiredUntil
  };
}

export function applyPoolFeeYieldProfile(
  candidate: IngestCandidate,
  profile: PoolFeeYieldProfile | undefined
): IngestCandidate {
  if (!profile) {
    return {
      ...candidate,
      poolFeeYieldStatus: 'yield_profile_missing',
      poolFeeYieldScore: 0,
      poolFeeYieldReason: 'yield-profile-missing'
    };
  }

  return {
    ...candidate,
    poolFeeYieldStatus: profile.status,
    poolFeeYieldScore: profile.score,
    poolFeeYieldReason: profile.reason,
    netFeeUsd1h: profile.netFeeUsd1h,
    netFeeYield30m: profile.netFeeYield30m,
    netFeeYield1h: profile.netFeeYield1h,
    netFeeYield2h: profile.netFeeYield2h,
    netFeeYield4h: profile.netFeeYield4h,
    tvlChange1hPct: profile.tvlChange1hPct,
    feeYieldObservedAt: profile.observedAt
  };
}

export function buildPoolFeeYieldObservation(input: {
  strategyId: StrategyId;
  candidate: IngestCandidate;
  profile: PoolFeeYieldProfile | undefined;
  now: Date;
  ttlMs: number;
}): CandidateSourceObservation {
  const profile = input.profile;
  const status = profile?.status;
  const blocked = status === 'retired_liquidity_drain'
    || status === 'denominator_fake_yield'
    || status === 'liquidity_drain_watch';

  return {
    strategyId: input.strategyId,
    poolAddress: input.candidate.address,
    tokenMint: input.candidate.mint,
    source: 'pool_fee_yield',
    status: !profile ? 'deferred' : blocked ? 'blocked' : 'passed',
    observedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + Math.max(0, input.ttlMs)).toISOString(),
    latencyMs: 0,
    score: profile && !blocked ? profile.score : 0,
    hardRejectReason: blocked && profile ? (profile.reason || status || 'pool-fee-yield-blocked') : '',
    rawJson: profile ? { ...profile } : {
      status: 'yield_profile_missing'
    }
  };
}
