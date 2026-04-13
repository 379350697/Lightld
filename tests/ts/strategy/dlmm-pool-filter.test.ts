import { describe, expect, it } from 'vitest';

import {
  evaluateDlmmPool,
  deduplicateByToken,
  selectDlmmPools,
  isSolPaired,
  getNonSolSymbol,
  getNonSolMint,
  type DlmmPoolCandidate,
  type DlmmPoolFilterConfig
} from '../../../src/strategy/filtering/dlmm-pool-filter';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_A_MINT = 'TokenAMintAddress111111111111111111111111111';
const TOKEN_B_MINT = 'TokenBMintAddress222222222222222222222222222';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const DEFAULT_CONFIG: DlmmPoolFilterConfig = {
  minBinStep: 100,
  minTvlUsd: 10000,
  minVolume24hUsd: 1000,
  minFeeTvlRatio24h: 0
};

function makePool(overrides: Partial<DlmmPoolCandidate> = {}): DlmmPoolCandidate {
  return {
    address: 'pool-address-1',
    name: 'TOKENA-SOL',
    tokenXMint: TOKEN_A_MINT,
    tokenXSymbol: 'TOKENA',
    tokenYMint: SOL_MINT,
    tokenYSymbol: 'SOL',
    binStep: 100,
    baseFeePct: 1.0,
    tvl: 50000,
    volume24h: 5000,
    feeTvlRatio24h: 0.001,
    isBlacklisted: false,
    ...overrides
  };
}

describe('isSolPaired', () => {
  it('returns true when SOL is token_y', () => {
    expect(isSolPaired(makePool({ tokenYMint: SOL_MINT }))).toBe(true);
  });

  it('returns true when SOL is token_x', () => {
    expect(isSolPaired(makePool({ tokenXMint: SOL_MINT, tokenYMint: TOKEN_A_MINT }))).toBe(true);
  });

  it('returns false when neither side is SOL', () => {
    expect(isSolPaired(makePool({ tokenXMint: TOKEN_A_MINT, tokenYMint: USDC_MINT }))).toBe(false);
  });
});

describe('getNonSolSymbol', () => {
  it('returns token_x symbol when SOL is token_y', () => {
    expect(getNonSolSymbol(makePool())).toBe('TOKENA');
  });

  it('returns token_y symbol when SOL is token_x', () => {
    expect(getNonSolSymbol(makePool({
      tokenXMint: SOL_MINT, tokenXSymbol: 'SOL',
      tokenYMint: TOKEN_A_MINT, tokenYSymbol: 'TOKENA'
    }))).toBe('TOKENA');
  });
});

describe('getNonSolMint', () => {
  it('returns token_x mint when SOL is token_y', () => {
    expect(getNonSolMint(makePool())).toBe(TOKEN_A_MINT);
  });

  it('returns token_y mint when SOL is token_x', () => {
    expect(getNonSolMint(makePool({
      tokenXMint: SOL_MINT, tokenYMint: TOKEN_B_MINT
    }))).toBe(TOKEN_B_MINT);
  });
});

describe('evaluateDlmmPool', () => {
  it('accepts a valid SOL-paired pool with bin_step >= 100', () => {
    const result = evaluateDlmmPool(makePool(), DEFAULT_CONFIG);
    expect(result.accepted).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects blacklisted pool', () => {
    const result = evaluateDlmmPool(makePool({ isBlacklisted: true }), DEFAULT_CONFIG);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('blacklisted');
  });

  it('rejects non-SOL-paired pool', () => {
    const result = evaluateDlmmPool(
      makePool({ tokenXMint: TOKEN_A_MINT, tokenYMint: USDC_MINT }),
      DEFAULT_CONFIG
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('not-sol-paired');
  });

  it('rejects pool with bin_step below minimum', () => {
    const result = evaluateDlmmPool(makePool({ binStep: 50 }), DEFAULT_CONFIG);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('bin-step-too-low')
    ]));
  });

  it('rejects pool with insufficient TVL', () => {
    const result = evaluateDlmmPool(makePool({ tvl: 5000 }), DEFAULT_CONFIG);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('insufficient-tvl');
  });

  it('rejects pool with insufficient 24h volume', () => {
    const result = evaluateDlmmPool(makePool({ volume24h: 500 }), DEFAULT_CONFIG);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('insufficient-volume');
  });

  it('rejects pool with low fee/tvl ratio when threshold is set', () => {
    const config = { ...DEFAULT_CONFIG, minFeeTvlRatio24h: 0.005 };
    const result = evaluateDlmmPool(makePool({ feeTvlRatio24h: 0.001 }), config);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('low-fee-tvl-ratio');
  });

  it('ignores fee/tvl ratio when threshold is 0', () => {
    const result = evaluateDlmmPool(makePool({ feeTvlRatio24h: 0 }), DEFAULT_CONFIG);
    expect(result.accepted).toBe(true);
  });

  it('collects multiple rejection reasons', () => {
    const result = evaluateDlmmPool(
      makePool({ isBlacklisted: true, binStep: 10, tvl: 100 }),
      DEFAULT_CONFIG
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('deduplicateByToken', () => {
  it('keeps the highest TVL pool for the same token', () => {
    const pools = [
      makePool({ address: 'pool-1', tvl: 30000 }),
      makePool({ address: 'pool-2', tvl: 80000 }),
      makePool({ address: 'pool-3', tvl: 50000 })
    ];
    const result = deduplicateByToken(pools);
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe('pool-2');
  });

  it('keeps separate entries for different tokens', () => {
    const pools = [
      makePool({ address: 'pool-a', tokenXMint: TOKEN_A_MINT, tokenXSymbol: 'A', tvl: 50000 }),
      makePool({ address: 'pool-b', tokenXMint: TOKEN_B_MINT, tokenXSymbol: 'B', tvl: 60000 })
    ];
    const result = deduplicateByToken(pools);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateByToken([])).toEqual([]);
  });
});

describe('selectDlmmPools', () => {
  it('filters, deduplicates, and sorts by TVL', () => {
    const pools = [
      makePool({ address: 'low-tvl', tvl: 20000, tokenXMint: TOKEN_A_MINT, tokenXSymbol: 'A' }),
      makePool({ address: 'high-tvl', tvl: 90000, tokenXMint: TOKEN_B_MINT, tokenXSymbol: 'B' }),
      makePool({ address: 'rejected', tvl: 5000, tokenXMint: 'rejected-mint', tokenXSymbol: 'C' }),
      makePool({ address: 'dup-a', tvl: 50000, tokenXMint: TOKEN_A_MINT, tokenXSymbol: 'A' })
    ];
    const result = selectDlmmPools(pools, DEFAULT_CONFIG);

    // 'rejected' filtered out (tvl < 10000)
    // TOKEN_A deduped: 'dup-a' (50k) wins over 'low-tvl' (20k)
    // sorted: high-tvl (90k) > dup-a (50k)
    expect(result).toHaveLength(2);
    expect(result[0].address).toBe('high-tvl');
    expect(result[1].address).toBe('dup-a');
  });
});
