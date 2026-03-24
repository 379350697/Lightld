import { describe, expect, it } from 'vitest';

import { fetchMeteoraOhlcv, fetchMeteoraPools } from '../../../src/ingest/meteora/client';

describe('fetchMeteoraPools', () => {
  it('attaches source metadata and forwards validated query params', async () => {
    let requestedUrl = '';

    const result = await fetchMeteoraPools({
      page: 2,
      pageSize: 25,
      query: 'SOL',
      sortBy: 'tvl:desc',
      filterBy: 'is_blacklisted=false && tvl>1000',
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify([{ address: 'POOL123' }]), { status: 200 });
      }
    });

    expect(requestedUrl).toContain('page=2');
    expect(requestedUrl).toContain('page_size=25');
    expect(requestedUrl).toContain('query=SOL');
    expect(requestedUrl).toContain('sort_by=tvl%3Adesc');
    expect(requestedUrl).toContain('filter_by=is_blacklisted%3Dfalse');
    expect(result[0].source).toBe('meteora');
    expect(result[0].raw).toEqual({ address: 'POOL123' });
  });
});

describe('fetchMeteoraOhlcv', () => {
  it('builds the ohlcv url with validated address and timeframe params', async () => {
    let requestedUrl = '';

    const result = await fetchMeteoraOhlcv('J1toso1uZXJ3kLF6sWzKp9D6M3j4Y6sV7n1uA8H7yCw', {
      timeframe: '1h',
      startTime: 1700000000,
      endTime: 1700003600,
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            data: [
              {
                timestamp: 1700000000,
                open: 1,
                high: 2,
                low: 0.5,
                close: 1.5,
                volume: 100
              }
            ],
            timeframe: '1h',
            start_time: 1700000000,
            end_time: 1700003600
          }),
          { status: 200 }
        );
      }
    });

    expect(requestedUrl).toContain('/pools/J1toso1uZXJ3kLF6sWzKp9D6M3j4Y6sV7n1uA8H7yCw/ohlcv');
    expect(requestedUrl).toContain('timeframe=1h');
    expect(requestedUrl).toContain('start_time=1700000000');
    expect(result.timeframe).toBe('1h');
  });
});
