import { EMPTY_AUXILIARY_SIGNAL_FIELDS } from '../ingest/signals/types.ts';
import type { IngestCandidate } from '../runtime/ingest-candidate-selection.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const MIN_METEORA_ENTRY_BIN_STEP = 80;
export const MAX_METEORA_ENTRY_BIN_STEP = 200;

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawRecord(value: RawRecord) {
  return isRecord(value.raw) ? value.raw : value;
}

function readNumber(payload: RawRecord, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function readString(payload: RawRecord, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function readBoolean(payload: RawRecord, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
  }
  return false;
}

function readTimestamp(payload: RawRecord, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    if (Number.isFinite(numeric) && numeric > 0) {
      const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
      return new Date(milliseconds).toISOString();
    }
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return '';
}

function resolveNestedString(payload: RawRecord, objectKeys: string[], valueKeys: string[]) {
  for (const objectKey of objectKeys) {
    const objectValue = payload[objectKey];
    if (!isRecord(objectValue)) continue;
    const value = readString(objectValue, valueKeys);
    if (value) return value;
  }
  return '';
}

export function isRecentMeteoraPool(row: RawRecord, now: Date, maxAgeMs: number) {
  const payload = rawRecord(row);
  const createdAt = Date.parse(readTimestamp(payload, ['created_at', 'createdAt', 'pool_created_at']));
  const ageMs = now.getTime() - createdAt;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
}

export function hasMeteoraSolRoute(row: RawRecord) {
  const payload = rawRecord(row);
  const quoteMint = readString(payload, ['quoteMint', 'quote_mint', 'token_y_mint'])
    || resolveNestedString(payload, ['token_y', 'tokenY'], ['address', 'mint']);
  const baseMint = readString(payload, ['baseMint', 'base_mint', 'mint', 'token_x_mint'])
    || resolveNestedString(payload, ['token_x', 'tokenX'], ['address', 'mint']);
  const pairName = readString(payload, ['name', 'pair_name', 'symbol']).toUpperCase();

  return quoteMint === SOL_MINT || baseMint === SOL_MINT || pairName.includes('SOL');
}

export function isMeteoraPoolPrefiltered(row: RawRecord, now: Date, maxAgeMs: number) {
  const payload = rawRecord(row);
  const poolConfig = isRecord(payload.pool_config) ? payload.pool_config : {};
  const isBlacklisted = readBoolean(payload, ['is_blacklisted', 'isBlacklisted']);
  const binStep = readNumber(poolConfig, ['bin_step', 'binStep']);
  return hasMeteoraSolRoute(row) && !isBlacklisted && isAllowedMeteoraEntryBinStep(binStep) && isRecentMeteoraPool(row, now, maxAgeMs);
}

export function isAllowedMeteoraEntryBinStep(binStep: number) {
  return binStep >= MIN_METEORA_ENTRY_BIN_STEP && binStep <= MAX_METEORA_ENTRY_BIN_STEP;
}

export function buildMeteoraCandidate(row: RawRecord): IngestCandidate {
  const payload = rawRecord(row);
  const tokenXMint = readString(payload, ['baseMint', 'base_mint', 'mint', 'token_x_mint'])
    || resolveNestedString(payload, ['token_x', 'tokenX'], ['address', 'mint']);
  const tokenXSymbol = readString(payload, ['baseSymbol', 'base_symbol', 'symbol', 'token_x_symbol'])
    || resolveNestedString(payload, ['token_x', 'tokenX'], ['symbol']);
  const tokenYMint = readString(payload, ['quoteMint', 'quote_mint', 'token_y_mint'])
    || resolveNestedString(payload, ['token_y', 'tokenY'], ['address', 'mint']);
  const tokenYSymbol = readString(payload, ['quoteSymbol', 'quote_symbol', 'token_y_symbol'])
    || resolveNestedString(payload, ['token_y', 'tokenY'], ['symbol']);
  const mint = tokenXMint === SOL_MINT ? tokenYMint : tokenXMint;
  const symbol = tokenXMint === SOL_MINT ? tokenYSymbol : tokenXSymbol;
  const quoteMint = tokenXMint === SOL_MINT ? tokenXMint : tokenYMint;
  const poolConfig = isRecord(payload.pool_config) ? payload.pool_config : {};
  const volumeObj = isRecord(payload.volume) ? payload.volume : {};
  const feeTvlObj = isRecord(payload.fee_tvl_ratio) ? payload.fee_tvl_ratio : {};

  return {
    ...EMPTY_AUXILIARY_SIGNAL_FIELDS,
    address: readString(payload, ['address', 'poolAddress', 'pool_address']),
    mint,
    symbol,
    chain: 'solana',
    quoteMint,
    liquidityUsd: readNumber(payload, ['liquidityUsd', 'liquidity', 'tvl', 'tvlUsd']),
    hasSolRoute: hasMeteoraSolRoute(row),
    capturedAt: readTimestamp(payload, ['created_at', 'createdAt', 'pool_created_at', 'capturedAt']),
    holders: readNumber(payload, ['holders']),
    hasInventory: false,
    hasLpPosition: false,
    binStep: readNumber(poolConfig, ['bin_step', 'binStep']),
    baseFeePct: readNumber(poolConfig, ['base_fee_pct', 'baseFeePct']),
    volume24h: readNumber(volumeObj, ['24h']) || readNumber(payload, ['volume_24h', 'volume24h']),
    feeTvlRatio24h: readNumber(feeTvlObj, ['24h']) || readNumber(payload, ['fee_tvl_ratio_24h', 'feeTvlRatio24h'])
  };
}
