import { describe, expect, it, vi } from 'vitest';

import { deriveCandidatePoolEntry } from '../../../src/candidate-pool/aggregator';
import { buildRouteObservation } from '../../../src/candidate-pool/source-observations';
import { runCandidateWorkerTick } from '../../../src/candidate-pool/worker';
import type {
  CandidatePoolEntry,
  CandidatePoolUpsert,
  CandidatePoolWriter,
  CandidateSourceAdapter,
  CandidateSourceObservation
} from '../../../src/candidate-pool/types';

function meteoraRow(overrides: Record<string, unknown> = {}) {
  return {
    address: 'pool-1',
    baseMint: 'mint-1',
    quoteMint: 'So11111111111111111111111111111111111111112',
    baseSymbol: 'SAFE',
    liquidityUsd: 25_000,
    created_at: new Date('2026-06-21T09:59:00.000Z').getTime(),
    pool_config: {
      bin_step: 120,
      base_fee_pct: 1
    },
    volume: { '24h': 2_000_000 },
    fee_tvl_ratio: { '24h': 0.12 },
    updatedAt: '2026-06-21T10:00:00.000Z',
    ...overrides
  };
}

class MemoryWriter implements CandidatePoolWriter {
  upserts: CandidatePoolUpsert[] = [];
  staleCalls: Array<{ observedAt: string; seen: Array<{ poolAddress: string; tokenMint: string }> }> = [];
  observations = new Map<string, CandidateSourceObservation[]>();

  async upsertCandidate(input: CandidatePoolUpsert): Promise<CandidatePoolEntry> {
    this.upserts.push(input);
    const key = `${input.strategyId}:${input.candidate.address}:${input.candidate.mint}`;
    const existing = this.observations.get(key) ?? [];
    const next = [
      ...existing.filter((observation) =>
        !input.sourceObservations.some((item) => item.source === observation.source)
      ),
      ...input.sourceObservations
    ];
    this.observations.set(key, next);
    return deriveCandidatePoolEntry({
      strategyId: input.strategyId,
      candidate: input.candidate,
      observations: next,
      now: new Date(input.observedAt)
    });
  }

  async markMissingOpenableStale(_strategyId: 'new-token-v1' | 'large-pool-v1', observedAt: string, seen: Array<{ poolAddress: string; tokenMint: string }>) {
    this.staleCalls.push({ observedAt, seen });
  }

  async writeWorkerStatus() {}
}

function routeSource(routeExists = true): CandidateSourceAdapter {
  return {
    source: 'jupiter_route',
    observe: vi.fn(async (candidate, context) => buildRouteObservation({
      strategyId: context.strategyId,
      candidate,
      now: context.now,
      ttlMs: 60_000,
      routeExists,
      hardRejectReason: 'no-jupiter-sol-route',
      rawJson: { routePlanLength: routeExists ? 1 : 0 }
    }))
  };
}

describe('candidate worker', () => {
  it('writes hard source observations before running GMGN soft source', async () => {
    const writer = new MemoryWriter();
    const fetchTokenSafetyBatchImpl = vi.fn(async () => {
      expect(writer.upserts.map((upsert) => upsert.sourceObservations.map((item) => item.source))).toEqual([
        ['meteora'],
        ['jupiter_route']
      ]);
      return [{
        mint: 'mint-1',
        safe: true,
        safetyScore: 80,
        maxScore: 120
      }];
    });

    const result = await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: routeSource(true),
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [meteoraRow()],
      fetchTokenSafetyBatchImpl,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(result).toMatchObject({
      fetchedPoolCount: 1,
      prefilteredCount: 1,
      lpEligibleCount: 1,
      openableCount: 1,
      gmgnCheckedCount: 1
    });
    expect(writer.upserts.some((upsert) => upsert.sourceObservations.some((item) => item.source === 'gmgn'))).toBe(true);
    expect(writer.staleCalls[0]?.seen).toEqual([{ poolAddress: 'pool-1', tokenMint: 'mint-1' }]);
  });

  it('keeps the worker tick alive when GMGN fails', async () => {
    const writer = new MemoryWriter();

    await expect(runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: routeSource(true),
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [meteoraRow()],
      fetchTokenSafetyBatchImpl: async () => {
        throw new Error('gmgn timeout');
      },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).resolves.toMatchObject({
      lpEligibleCount: 1,
      gmgnCheckedCount: 1
    });

    expect(writer.upserts.map((upsert) => upsert.sourceObservations.map((item) => item.source))).toEqual([
      ['meteora'],
      ['jupiter_route']
    ]);
  });

  it('does not run GMGN for candidates without a fresh Jupiter route', async () => {
    const writer = new MemoryWriter();
    const fetchTokenSafetyBatchImpl = vi.fn(async () => []);

    await expect(runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: routeSource(false),
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [meteoraRow()],
      fetchTokenSafetyBatchImpl,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).resolves.toMatchObject({
      lpEligibleCount: 1,
      openableCount: 0,
      gmgnCheckedCount: 0
    });

    expect(fetchTokenSafetyBatchImpl).not.toHaveBeenCalled();
    expect(writer.upserts.map((upsert) => upsert.sourceObservations.map((item) => item.source))).toEqual([
      ['meteora'],
      ['jupiter_route']
    ]);
  });

  it('filters Meteora entry pools outside the 80 to 200 bin step band before route checks', async () => {
    const writer = new MemoryWriter();
    const route = routeSource(true);

    const result = await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: route,
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        meteoraRow({ address: 'pool-too-small', baseMint: 'mint-small', baseSymbol: 'SMALL', pool_config: { bin_step: 79, base_fee_pct: 1 } }),
        meteoraRow({ address: 'pool-ok', baseMint: 'mint-ok', baseSymbol: 'OK', pool_config: { bin_step: 80, base_fee_pct: 1 } }),
        meteoraRow({ address: 'pool-too-large', baseMint: 'mint-large', baseSymbol: 'LARGE', pool_config: { bin_step: 201, base_fee_pct: 1 } })
      ],
      fetchTokenSafetyBatchImpl: async () => [],
      gmgnSourceMode: 'disabled',
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(result).toMatchObject({
      fetchedPoolCount: 3,
      prefilteredCount: 1,
      lpEligibleCount: 1
    });
    expect(route.observe).toHaveBeenCalledTimes(1);
    expect(writer.upserts.map((upsert) => upsert.candidate.address)).toEqual([
      'pool-ok',
      'pool-ok'
    ]);
    expect(writer.staleCalls[0]?.seen).toEqual([{ poolAddress: 'pool-ok', tokenMint: 'mint-ok' }]);
  });
});
