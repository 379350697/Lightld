export const METEORA_TIMEFRAMES = ['5m', '30m', '1h', '2h', '4h', '12h', '24h'] as const;
export const METEORA_POOLS_MAX_PAGE_SIZE = 1000;
export const METEORA_REQUESTS_PER_SECOND = 30;

type MeteoraPoolQuery = {
  page?: number;
  pageSize?: number;
  query?: string;
  sortBy?: string;
  filterBy?: string;
};

type MeteoraOhlcvQuery = {
  timeframe?: (typeof METEORA_TIMEFRAMES)[number];
  startTime?: number;
  endTime?: number;
};

const base58AddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const timeframePattern = METEORA_TIMEFRAMES.join('|');
const windowedSortFieldPattern = `(?:volume|fee|fee_tvl_ratio|apr)_(?:${timeframePattern})`;
const fixedSortFieldPattern = '(?:tvl|fee_pct|bin_step|pool_created_at|farm_apy)';
const sortByClausePattern = new RegExp(
  `^(?:${windowedSortFieldPattern}|${fixedSortFieldPattern}):(asc|desc)$`
);
const numericFilterFieldPattern = `(?:tvl|${windowedSortFieldPattern})`;
const numericFilterPattern = new RegExp(
  `^(${numericFilterFieldPattern})\\s*(=|>=|<=|>|<)\\s*(-?\\d+(?:\\.\\d+)?)$`
);
const booleanFilterPattern = /^(is_blacklisted)\s*=\s*(true|false)$/;
const textFilterPattern = /^(pool_address|name|token_x|token_y)\s*=\s*([^=\[\]&]+)$/;
const textListFilterPattern = /^(pool_address|name|token_x|token_y)\s*=\s*\[([^\]]+)\]$/;

function invalidMeteoraParam(paramName: string, message: string) {
  throw new Error(`Invalid Meteora ${paramName}: ${message}`);
}

function normalizeMeteoraPoolsBaseUrl(baseUrl: string) {
  return baseUrl.endsWith('/pools')
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/pools`;
}

function requireInteger(
  paramName: string,
  value: number | undefined,
  options: {
    min: number;
    max?: number;
  }
) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value)) {
    invalidMeteoraParam(paramName, 'expected an integer');
  }

  if (value < options.min) {
    invalidMeteoraParam(paramName, `expected ${paramName} >= ${options.min}`);
  }

  if (options.max !== undefined && value > options.max) {
    invalidMeteoraParam(paramName, `expected ${paramName} <= ${options.max}`);
  }

  return value;
}

function requireNonEmptyString(paramName: string, value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    invalidMeteoraParam(paramName, 'expected a string');
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    invalidMeteoraParam(paramName, 'expected a non-empty string');
  }

  return normalized;
}

function normalizeFilterList(raw: string) {
  const values = raw
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    invalidMeteoraParam('filter_by', 'expected at least one list value');
  }

  return values.join('|');
}

export function validateMeteoraSortBy(value: string) {
  const clauses = value
    .split(',')
    .map((clause) => clause.trim())
    .filter(Boolean);

  if (clauses.length === 0) {
    invalidMeteoraParam('sort_by', 'expected one or more sort clauses');
  }

  for (const clause of clauses) {
    if (!sortByClausePattern.test(clause)) {
      invalidMeteoraParam('sort_by', `unsupported clause "${clause}"`);
    }
  }

  return clauses.join(',');
}

export function validateMeteoraFilterBy(value: string) {
  const clauses = value
    .split('&&')
    .map((clause) => clause.trim())
    .filter(Boolean);

  if (clauses.length === 0) {
    invalidMeteoraParam('filter_by', 'expected one or more filter clauses');
  }

  const normalized = clauses.map((clause) => {
    const booleanMatch = clause.match(booleanFilterPattern);

    if (booleanMatch) {
      const [, field, flag] = booleanMatch;
      return `${field}=${flag}`;
    }

    const numericMatch = clause.match(numericFilterPattern);

    if (numericMatch) {
      const [, field, operator, rawValue] = numericMatch;
      return `${field}${operator}${rawValue}`;
    }

    const textListMatch = clause.match(textListFilterPattern);

    if (textListMatch) {
      const [, field, rawValues] = textListMatch;
      return `${field}=[${normalizeFilterList(rawValues)}]`;
    }

    const textMatch = clause.match(textFilterPattern);

    if (textMatch) {
      const [, field, rawValue] = textMatch;
      return `${field}=${rawValue.trim()}`;
    }

    invalidMeteoraParam('filter_by', `unsupported clause "${clause}"`);
  });

  return normalized.join(' && ');
}

function normalizeMeteoraPoolsQuery(query: MeteoraPoolQuery) {
  const sortBy = requireNonEmptyString('sort_by', query.sortBy);
  const filterBy = requireNonEmptyString('filter_by', query.filterBy);

  return {
    page: requireInteger('page', query.page, { min: 1 }),
    pageSize: requireInteger('page_size', query.pageSize, {
      min: 1,
      max: METEORA_POOLS_MAX_PAGE_SIZE
    }),
    query: requireNonEmptyString('query', query.query),
    sortBy: sortBy === undefined ? undefined : validateMeteoraSortBy(sortBy),
    filterBy: filterBy === undefined ? undefined : validateMeteoraFilterBy(filterBy)
  };
}

function normalizeMeteoraOhlcvQuery(query: MeteoraOhlcvQuery) {
  const timeframe = requireNonEmptyString('timeframe', query.timeframe);

  if (timeframe !== undefined && !METEORA_TIMEFRAMES.includes(timeframe as (typeof METEORA_TIMEFRAMES)[number])) {
    invalidMeteoraParam('timeframe', `expected one of ${METEORA_TIMEFRAMES.join(', ')}`);
  }

  const startTime = requireInteger('start_time', query.startTime, { min: 0 });
  const endTime = requireInteger('end_time', query.endTime, { min: 0 });

  if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
    invalidMeteoraParam('start_time', 'expected start_time <= end_time');
  }

  return {
    timeframe: timeframe as MeteoraOhlcvQuery['timeframe'] | undefined,
    startTime,
    endTime
  };
}

export function buildMeteoraPoolsUrl(baseUrl: string, query: MeteoraPoolQuery = {}) {
  const parsed = normalizeMeteoraPoolsQuery(query);
  const url = new URL(normalizeMeteoraPoolsBaseUrl(baseUrl));

  if (parsed.page !== undefined) {
    url.searchParams.set('page', String(parsed.page));
  }

  if (parsed.pageSize !== undefined) {
    url.searchParams.set('page_size', String(parsed.pageSize));
  }

  if (parsed.query) {
    url.searchParams.set('query', parsed.query);
  }

  if (parsed.sortBy) {
    url.searchParams.set('sort_by', parsed.sortBy);
  }

  if (parsed.filterBy) {
    url.searchParams.set('filter_by', parsed.filterBy);
  }

  return url.toString();
}

export function buildMeteoraOhlcvUrl(
  baseUrl: string,
  address: string,
  query: MeteoraOhlcvQuery = {}
) {
  if (!base58AddressPattern.test(address)) {
    invalidMeteoraParam('address', `expected a base58 pool address, received "${address}"`);
  }

  const parsed = normalizeMeteoraOhlcvQuery(query);
  const url = new URL(`${normalizeMeteoraPoolsBaseUrl(baseUrl)}/${address}/ohlcv`);

  if (parsed.timeframe) {
    url.searchParams.set('timeframe', parsed.timeframe);
  }

  if (parsed.startTime !== undefined) {
    url.searchParams.set('start_time', String(parsed.startTime));
  }

  if (parsed.endTime !== undefined) {
    url.searchParams.set('end_time', String(parsed.endTime));
  }

  return url.toString();
}
