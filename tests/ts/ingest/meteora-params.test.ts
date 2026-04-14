import { describe, expect, it } from 'vitest';

import {
  buildMeteoraOhlcvUrl,
  buildMeteoraPoolsUrl,
  validateMeteoraFilterBy,
  validateMeteoraSortBy
} from '../../../src/ingest/meteora/params';

describe('Meteora params', () => {
  it('rejects pool page_size values above the documented maximum', () => {
    expect(() =>
      buildMeteoraPoolsUrl('https://dlmm.datapi.meteora.ag/pools', {
        pageSize: 1001
      })
    ).toThrow(/page_size/i);
  });

  it('rejects invalid sort_by expressions', () => {
    expect(() => validateMeteoraSortBy('unknown:desc')).toThrow(/sort_by/i);
  });

  it('accepts documented sort_by expressions', () => {
    expect(validateMeteoraSortBy('volume_24h:desc')).toBe('volume_24h:desc');
    expect(validateMeteoraSortBy('fee_tvl_ratio_1h:asc')).toBe('fee_tvl_ratio_1h:asc');
    expect(validateMeteoraSortBy('apr_24h:desc')).toBe('apr_24h:desc');
    expect(validateMeteoraSortBy('tvl:desc')).toBe('tvl:desc');
  });

  it('accepts documented filter_by expressions', () => {
    expect(validateMeteoraFilterBy('is_blacklisted=false && tvl>1000')).toBe(
      'is_blacklisted=false && tvl>1000'
    );
    expect(validateMeteoraFilterBy('fee_tvl_ratio_1h>=0.25 && apr_24h>10')).toBe(
      'fee_tvl_ratio_1h>=0.25 && apr_24h>10'
    );
    expect(validateMeteoraFilterBy('is_blacklisted = false && tvl > 1000')).toBe(
      'is_blacklisted=false && tvl>1000'
    );
    expect(validateMeteoraFilterBy('token_x=[SOL|USDC]')).toBe('token_x=[SOL|USDC]');
  });

  it('rejects invalid filter_by expressions', () => {
    expect(() => validateMeteoraFilterBy('unsupported=true')).toThrow(/filter_by/i);
  });

  it('rejects invalid OHLCV timeframes and negative timestamps', () => {
    expect(() =>
      buildMeteoraOhlcvUrl(
        'https://dlmm.datapi.meteora.ag',
        'J1toso1uZXJ3kLF6sWzKp9D6M3j4Y6sV7n1uA8H7yCw',
        { timeframe: '10m' as '1h', startTime: -1 }
      )
    ).toThrow();
  });

  it('rejects OHLCV ranges where start_time is after end_time', () => {
    expect(() =>
      buildMeteoraOhlcvUrl(
        'https://dlmm.datapi.meteora.ag',
        'J1toso1uZXJ3kLF6sWzKp9D6M3j4Y6sV7n1uA8H7yCw',
        {
          timeframe: '1h',
          startTime: 1700003600,
          endTime: 1700000000
        }
      )
    ).toThrow(/start_time/i);
  });
});
