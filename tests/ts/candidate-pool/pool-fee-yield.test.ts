import { describe, expect, it } from 'vitest';

import {
  applyPoolFeeYieldProfile,
  buildPoolFeeYieldProfile,
  parseMeteoraPoolFeeYieldSample
} from '../../../src/candidate-pool/pool-fee-yield';
import type { IngestCandidate } from '../../../src/runtime/ingest-candidate-selection';

function poolRow(overrides: Record<string, unknown> = {}) {
  return {
    address: 'pool-1',
    token_x: {
      address: 'mint-1',
      symbol: 'SAFE'
    },
    token_y: {
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL'
    },
    tvl: 10_000,
    fees: {
      '30m': 80,
      '1h': 150,
      '2h': 250,
      '4h': 520,
      '12h': 1_200,
      '24h': 2_000
    },
    protocol_fees: {
      '30m': 8,
      '1h': 15,
      '2h': 25,
      '4h': 52,
      '12h': 120,
      '24h': 200
    },
    volume: {
      '1h': 5_000
    },
    ...overrides
  };
}

function candidate(): IngestCandidate {
  return {
    address: 'pool-1',
    mint: 'mint-1',
    symbol: 'SAFE',
    quoteMint: 'So11111111111111111111111111111111111111112',
    liquidityUsd: 10_000,
    hasSolRoute: true,
    capturedAt: '2026-06-24T10:00:00.000Z',
    holders: 0,
    hasInventory: false,
    hasLpPosition: false,
    binStep: 100,
    baseFeePct: 1,
    volume24h: 100_000,
    feeTvlRatio24h: 0.2
  };
}

describe('pool fee yield profile', () => {
  it('uses net LP fees after protocol fees for fee/liquidity yield', () => {
    const sample = parseMeteoraPoolFeeYieldSample(poolRow(), new Date('2026-06-24T10:00:00.000Z'));
    expect(sample).not.toBeNull();
    expect(sample?.netFeesUsd['1h']).toBe(135);
    expect(sample?.netFeeYield['1h']).toBeCloseTo(0.0135, 8);

    const profile = buildPoolFeeYieldProfile({ sample: sample! });
    expect(profile.netFeeUsd1h).toBe(135);
    expect(profile.netFeeYield1h).toBeCloseTo(0.0135, 8);
    expect(profile.status).toBe('ready');
  });

  it('caps fee yield score at 105 for strong sustained fee/liquidity profiles', () => {
    const sample = parseMeteoraPoolFeeYieldSample(poolRow({
      fees: {
        '30m': 8_000,
        '1h': 8_100,
        '2h': 8_200,
        '4h': 12_000,
        '12h': 20_000,
        '24h': 30_000
      },
      protocol_fees: {
        '30m': 0,
        '1h': 0,
        '2h': 0,
        '4h': 0,
        '12h': 0,
        '24h': 0
      }
    }), new Date('2026-06-24T10:00:00.000Z'));
    const profile = buildPoolFeeYieldProfile({ sample: sample! });

    expect(profile.status).toBe('ready');
    expect(profile.score).toBe(105);
  });

  it('limits high-ratio small-fee pools by absolute net fee size', () => {
    const sample = parseMeteoraPoolFeeYieldSample(poolRow({
      tvl: 1_000,
      fees: {
        '30m': 17,
        '1h': 18,
        '2h': 19,
        '4h': 22,
        '12h': 30,
        '24h': 40
      },
      protocol_fees: {
        '30m': 0,
        '1h': 0,
        '2h': 0,
        '4h': 0,
        '12h': 0,
        '24h': 0
      }
    }), new Date('2026-06-24T10:00:00.000Z'));
    const profile = buildPoolFeeYieldProfile({ sample: sample! });

    expect(profile.status).toBe('ready');
    expect(profile.netFeeYield1h).toBeCloseTo(0.018, 8);
    expect(profile.netFeeUsd1h).toBe(18);
    expect(profile.score).toBeLessThanOrEqual(20);
  });

  it('awards materially higher continuity points for sustained 2h/4h fee yield', () => {
    const continuous = buildPoolFeeYieldProfile({
      sample: parseMeteoraPoolFeeYieldSample(poolRow({
        fees: {
          '30m': 80,
          '1h': 150,
          '2h': 250,
          '4h': 520,
          '12h': 1_200,
          '24h': 2_000
        },
        protocol_fees: {
          '30m': 0,
          '1h': 0,
          '2h': 0,
          '4h': 0,
          '12h': 0,
          '24h': 0
        }
      }), new Date('2026-06-24T10:00:00.000Z'))!
    });
    const burst = buildPoolFeeYieldProfile({
      sample: parseMeteoraPoolFeeYieldSample(poolRow({
        fees: {
          '30m': 80,
          '1h': 150,
          '2h': 250,
          '4h': 2_000,
          '12h': 2_500,
          '24h': 3_000
        },
        protocol_fees: {
          '30m': 0,
          '1h': 0,
          '2h': 0,
          '4h': 0,
          '12h': 0,
          '24h': 0
        }
      }), new Date('2026-06-24T10:00:00.000Z'))!
    });

    expect(continuous.score - burst.score).toBeCloseTo(15, 5);
  });

  it('detects denominator fake yield when TVL drains but net fees do not grow', () => {
    const sample = parseMeteoraPoolFeeYieldSample(poolRow({
      tvl: 6_000,
      fees: {
        '30m': 48,
        '1h': 100,
        '2h': 170,
        '4h': 400,
        '12h': 900,
        '24h': 1_800
      },
      protocol_fees: {
        '30m': 5,
        '1h': 10,
        '2h': 17,
        '4h': 40,
        '12h': 90,
        '24h': 180
      }
    }), new Date('2026-06-24T10:00:00.000Z'));
    const profile = buildPoolFeeYieldProfile({
      sample: sample!,
      previousTvlUsd: 10_000
    });

    expect(profile.status).toBe('denominator_fake_yield');
    expect(profile.score).toBe(0);
    expect(profile.fakeYieldReason).toContain('liquidity-drain');
  });

  it('retires pools after severe liquidity drain or minimum TVL breach', () => {
    const sample = parseMeteoraPoolFeeYieldSample(poolRow({ tvl: 4_900 }), new Date('2026-06-24T10:00:00.000Z'));
    const profile = buildPoolFeeYieldProfile({
      sample: sample!,
      previousTvlUsd: 10_000,
      minTvlUsd: 1_000,
      retirementMs: 6 * 60 * 60 * 1000
    });

    expect(profile.status).toBe('retired_liquidity_drain');
    expect(profile.retiredUntil).toBe('2026-06-24T16:00:00.000Z');
  });

  it('hard blocks one-hour liquidity drain watch without retiring the pool', () => {
    const sample = parseMeteoraPoolFeeYieldSample(poolRow({
      tvl: 6_400,
      fees: {
        '30m': 40,
        '1h': 100,
        '2h': 260,
        '4h': 520,
        '12h': 1_200,
        '24h': 2_000
      }
    }), new Date('2026-06-24T10:00:00.000Z'));
    const profile = buildPoolFeeYieldProfile({
      sample: sample!,
      previousTvlUsd: 10_000
    });

    expect(profile.status).toBe('liquidity_drain_watch');
    expect(profile.score).toBe(0);
    expect(profile.retiredUntil).toBeUndefined();
  });

  it('applies profile fields to candidates without replacing business identity fields', () => {
    const sample = parseMeteoraPoolFeeYieldSample(poolRow(), new Date('2026-06-24T10:00:00.000Z'));
    const profile = buildPoolFeeYieldProfile({ sample: sample! });
    const enriched = applyPoolFeeYieldProfile(candidate(), profile);

    expect(enriched).toMatchObject({
      address: 'pool-1',
      mint: 'mint-1',
      poolFeeYieldStatus: 'ready',
      poolFeeYieldScore: profile.score,
      netFeeUsd1h: 135
    });
  });
});
