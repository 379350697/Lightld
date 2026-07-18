import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { deriveCandidatePoolEntry } from '../../../src/candidate-pool/aggregator';
import { buildRouteObservation } from '../../../src/candidate-pool/source-observations';
import { SqliteCandidatePool } from '../../../src/candidate-pool/sqlite-candidate-pool';
import { runCandidateWorkerTick } from '../../../src/candidate-pool/worker';
import { loadStrategyConfig } from '../../../src/config/loader';
import { GMGN_SAFETY_DEFERRED_ERROR } from '../../../src/ingest/gmgn/token-safety-client';
import { SqliteCandidateResearchRecorder } from '../../../src/strategy-research/capture';
import { StrategyResearchStore } from '../../../src/strategy-research/store';
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
    fee_tvl_ratio: { '24h': 12 },
    updatedAt: '2026-06-21T10:00:00.000Z',
    ...overrides
  };
}

class MemoryWriter implements CandidatePoolWriter {
  upserts: CandidatePoolUpsert[] = [];
  staleCalls: Array<{ observedAt: string; seen: Array<{ poolAddress: string; tokenMint: string }> }> = [];
  observations = new Map<string, CandidateSourceObservation[]>();
  statuses: string[] = [];
  workerStatuses: Array<Parameters<CandidatePoolWriter['writeWorkerStatus']>[0]> = [];

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

  async writeWorkerStatus(input: Parameters<CandidatePoolWriter['writeWorkerStatus']>[0]) {
    this.statuses.push(input.status);
    this.workerStatuses.push(input);
  }
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
  it('writes route evidence before synchronously completing required GMGN safety', async () => {
    const writer = new MemoryWriter();
    const fetchTokenSafetyBatchImpl = vi.fn(async () => {
      expect(writer.upserts.map((upsert) => upsert.sourceObservations.map((item) => item.source))).toEqual([
        ['meteora', 'pool_fee_yield'],
        ['jupiter_route']
      ]);
      expect(writer.statuses).toEqual(['running']);
      return [{
        mint: 'mint-1',
        safe: true,
        safetyScore: 80,
        maxScore: 120,
        holders: 2_000,
        bluechipPct: -1
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
    expect(writer.statuses).toEqual(['running', 'ok']);
    expect(writer.workerStatuses.map((status) => status.expiresAt)).toEqual([
      '2026-06-21T10:20:00.000Z',
      '2026-06-21T10:20:00.000Z'
    ]);
    expect(writer.staleCalls[0]?.seen).toEqual([{ poolAddress: 'pool-1', tokenMint: 'mint-1' }]);
  });

  it('keeps the worker tick alive but fails candidates closed when GMGN fails', async () => {
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
      openableCount: 0,
      gmgnCheckedCount: 1
    });

    expect(writer.upserts.map((upsert) => upsert.sourceObservations.map((item) => item.source))).toEqual([
      ['meteora', 'pool_fee_yield'],
      ['jupiter_route'],
      ['gmgn']
    ]);
  });

  it('captures research candidates after synchronous GMGN blocks are applied', async () => {
    const writer = new MemoryWriter();
    const capture = vi.fn(async () => undefined);
    await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: routeSource(true),
      captureMode: 'mechanical-soak',
      researchRecorder: { capture },
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [meteoraRow()],
      fetchTokenSafetyBatchImpl: async () => [{
        mint: 'mint-1', safe: false, safetyScore: 5, maxScore: 120, rejectReasons: ['top10-holders-too-high']
      }],
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ candidates: [] }));
  });

  it('keeps candidate selection unchanged when research persistence fails', async () => {
    const writer = new MemoryWriter();
    const warn = vi.fn();
    const result = await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: routeSource(true),
      captureMode: 'mechanical-soak',
      researchRecorder: { capture: async () => { throw new Error('research disk full'); } },
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [meteoraRow()],
      fetchTokenSafetyBatchImpl: async () => [{
        mint: 'mint-1', safe: true, safetyScore: 80, maxScore: 120, holders: 2_000, bluechipPct: 1
      }],
      logger: { log: vi.fn(), warn, error: vi.fn() }
    });

    expect(result.openableCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trading candidates unchanged'));
  });

  it('skips research capture when the shared candidate read degrades without affecting trading candidates', async () => {
    const writer = new MemoryWriter();
    const capture = vi.fn(async (_input: unknown) => undefined);
    const warn = vi.fn();
    const result = await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: routeSource(true),
      captureMode: 'mechanical-soak',
      researchRecorder: { capture },
      researchCandidateReader: {
        listOpenableCandidates: async () => { throw new Error('candidate database busy'); },
        selectOpenableCandidate: async () => null
      },
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [meteoraRow()],
      fetchTokenSafetyBatchImpl: async () => [{
        mint: 'mint-1', safe: true, safetyScore: 80, maxScore: 120, holders: 2_000, bluechipPct: 1
      }],
      logger: { log: vi.fn(), warn, error: vi.fn() }
    });

    expect(result.openableCount).toBe(1);
    expect(capture).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('candidate read degraded'));
  });

  it('passes a successful empty shared candidate read through as real empty evidence', async () => {
    const writer = new MemoryWriter();
    const capture = vi.fn(async (_input: unknown) => undefined);
    await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: routeSource(true),
      captureMode: 'mechanical-soak',
      researchRecorder: { capture },
      researchCandidateReader: {
        listOpenableCandidates: async () => [],
        selectOpenableCandidate: async () => null
      },
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [meteoraRow()],
      fetchTokenSafetyBatchImpl: async () => [{
        mint: 'mint-1', safe: true, safetyScore: 80, maxScore: 120, holders: 2_000, bluechipPct: 1
      }],
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ candidates: [] }));
  });

  it('captures research from the same fresh database top set used by the daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-candidate-worker-research-'));
    const pool = new SqliteCandidatePool({ path: join(root, 'candidate.sqlite') });
    const researchStore = new StrategyResearchStore(join(root, 'research.sqlite'));
    const rows = Array.from({ length: 3 }, (_, index) => meteoraRow({
      address: `pool-${index + 1}`,
      baseMint: `mint-${index + 1}`,
      baseSymbol: `TOKEN${index + 1}`,
      created_at: new Date('2026-06-21T06:00:00.000Z').getTime(),
      fee_tvl_ratio: { '24h': 12 - index }
    }));
    const safety = (mints: string[]) => mints.map((mint) => ({
      mint, safe: true, safetyScore: 80, maxScore: 120, holders: 2_000, bluechipPct: 1
    }));

    try {
      await researchStore.open();
      const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
      researchStore.startExperiment({
        experimentId: 'candidate-db-parity',
        strategyId: 'new-token-v1',
        positionSol: 0.1,
        baseConfig: config,
        variants: [{ variantId: 'same', parameterPatch: { filters: { minLiquidityUsd: 1000 } } }],
        thresholds: { minimumEpisodes: 50, minimumUtcDays: 7, minimumOosEpisodes: 15, minimumMarkCoverage: 0.9 }
      }, '2026-06-21T09:59:00.000Z');
      await runCandidateWorkerTick({
        strategy: 'new-token-v1',
        writer: pool,
        routeSource: routeSource(true),
        routeMaximumPoolsPerTick: 5,
        routeDiscoveryPoolsPerTick: 5,
        now: () => new Date('2026-06-21T10:00:00.000Z'),
        fetchMeteoraPoolsImpl: async () => rows,
        fetchTokenSafetyBatchImpl: async (mints) => safety(mints),
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
      });

      const expected = (await pool.listOpenableCandidates('new-token-v1', {
        now: new Date('2026-06-21T10:00:15.000Z'),
        maxAgeMs: 3 * 60_000,
        limit: 20
      }))[0]!;
      await runCandidateWorkerTick({
        strategy: 'new-token-v1',
        writer: pool,
        routeSource: routeSource(true),
        routeMaximumPoolsPerTick: 1,
        routeDiscoveryPoolsPerTick: 1,
        now: () => new Date('2026-06-21T10:00:15.000Z'),
        fetchMeteoraPoolsImpl: async () => rows,
        gmgnSourceMode: 'disabled',
        captureMode: 'mechanical-soak',
        researchRecorder: new SqliteCandidateResearchRecorder(researchStore),
        researchCandidateReader: pool,
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
      });

      expect(researchStore.snapshotTimes('candidate-db-parity')).toEqual(['2026-06-21T10:00:15.000Z']);
      expect(researchStore.listEpisodes('candidate-db-parity')).toHaveLength(2);
      expect(researchStore.listEpisodes('candidate-db-parity').every((episode) =>
        episode.poolAddress === expected.poolAddress && episode.tokenMint === expected.tokenMint
      )).toBe(true);
      expect(researchStore.recordPaperSelection({
        strategyId: 'new-token-v1',
        poolAddress: expected.poolAddress,
        tokenMint: expected.tokenMint,
        selectedAt: '2026-06-21T10:00:16.000Z',
        action: 'add-lp',
        reason: 'paper-open'
      })).toMatchObject({ variantId: 'baseline' });
    } finally {
      researchStore.close();
      await pool.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes the full ranked route set to the throttled GMGN fetch so later candidates can rotate in', async () => {
    const writer = new MemoryWriter();
    let call = 0;
    const fetchSafety = vi.fn(async (mints: string[]) => {
      call += 1;
      expect(mints).toEqual(['mint-1', 'mint-2']);
      const passed = (mint: string) => ({
        mint, safe: true, safetyScore: 80, maxScore: 120, holders: 2_000, bluechipPct: 1
      });
      return call === 1
        ? [passed('mint-1'), { mint: 'mint-2', safe: false, safetyScore: 0, maxScore: 120, error: 'fetch_skipped:max_batch_size_zero' }]
        : [passed('mint-1'), passed('mint-2')];
    });
    const options = {
      strategy: 'new-token-v1' as const,
      writer,
      routeSource: routeSource(true),
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        meteoraRow(),
        meteoraRow({ address: 'pool-2', baseMint: 'mint-2', baseSymbol: 'SECOND' })
      ],
      fetchTokenSafetyBatchImpl: fetchSafety,
      gmgnMaxBatchSize: 1,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    };

    await expect(runCandidateWorkerTick(options)).resolves.toMatchObject({ openableCount: 1 });
    await expect(runCandidateWorkerTick(options)).resolves.toMatchObject({ openableCount: 2 });
    expect(fetchSafety).toHaveBeenCalledTimes(2);
  });

  it('bounds Jupiter work per tick and rotates discovery candidates instead of rescanning the full universe', async () => {
    const writer = new MemoryWriter();
    const route = routeSource(true);
    const rotationState = { priorityCursor: 0, discoveryCursor: 0 };
    const rows = Array.from({ length: 7 }, (_, index) => meteoraRow({
      address: `pool-${index + 1}`,
      baseMint: `mint-${index + 1}`,
      baseSymbol: `TOKEN${index + 1}`
    }));
    const options = {
      strategy: 'new-token-v1' as const,
      writer,
      routeSource: route,
      rotationState,
      routeMaximumPoolsPerTick: 5,
      routeDiscoveryPoolsPerTick: 2,
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => rows,
      gmgnSourceMode: 'disabled' as const,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    };

    await runCandidateWorkerTick(options);
    await runCandidateWorkerTick(options);

    expect(route.observe).toHaveBeenCalledTimes(4);
    expect(vi.mocked(route.observe).mock.calls.map(([candidate]) => candidate.address)).toEqual([
      'pool-1', 'pool-2',
      'pool-3', 'pool-4'
    ]);
  });

  it('reserves discovery capacity while rotating tracked and openable priority pools first', async () => {
    const writer = new MemoryWriter();
    const route = routeSource(true);
    const rows = Array.from({ length: 6 }, (_, index) => meteoraRow({
      address: `pool-${index + 1}`,
      baseMint: `mint-${index + 1}`,
      baseSymbol: `TOKEN${index + 1}`
    }));

    await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: route,
      routeMaximumPoolsPerTick: 4,
      routeDiscoveryPoolsPerTick: 1,
      rotationState: { priorityCursor: 0, discoveryCursor: 0 },
      readPriorityPoolAddresses: async () => ['pool-5', 'pool-4', 'pool-3', 'pool-2'],
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => rows,
      gmgnSourceMode: 'disabled',
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(vi.mocked(route.observe).mock.calls.map(([candidate]) => candidate.address)).toEqual([
      'pool-5', 'pool-4', 'pool-3', 'pool-1'
    ]);
  });

  it('alternates a one-pool quote budget without starving either priority or discovery', async () => {
    const writer = new MemoryWriter();
    const route = routeSource(true);
    const rotationState = { priorityCursor: 0, discoveryCursor: 0 };
    const options = {
      strategy: 'new-token-v1' as const,
      writer,
      routeSource: route,
      routeMaximumPoolsPerTick: 1,
      routeDiscoveryPoolsPerTick: 1,
      rotationState,
      readPriorityPoolAddresses: async () => ['pool-2'],
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        meteoraRow(),
        meteoraRow({ address: 'pool-2', baseMint: 'mint-2', baseSymbol: 'SECOND' })
      ],
      gmgnSourceMode: 'disabled' as const,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    };

    await runCandidateWorkerTick(options);
    await runCandidateWorkerTick(options);
    await runCandidateWorkerTick(options);
    await runCandidateWorkerTick(options);

    expect(vi.mocked(route.observe).mock.calls.map(([candidate]) => candidate.address)).toEqual([
      'pool-2', 'pool-2', 'pool-2', 'pool-1'
    ]);
  });

  it('refreshes tracked pools that fell outside the bounded top-pool page', async () => {
    const writer = new MemoryWriter();
    const route = routeSource(true);
    const fetchPools = vi.fn(async (options?: { filterBy?: string }) => options?.filterBy?.includes('tracked-pool')
      ? [meteoraRow({ address: 'tracked-pool', baseMint: 'tracked-mint', baseSymbol: 'TRACKED' })]
      : [meteoraRow()]);

    await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: route,
      routeMaximumPoolsPerTick: 2,
      routeDiscoveryPoolsPerTick: 1,
      readPriorityPoolAddresses: async () => ['tracked-pool'],
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: fetchPools,
      gmgnSourceMode: 'disabled',
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(fetchPools).toHaveBeenCalledTimes(2);
    expect(fetchPools.mock.calls[1]?.[0]).toMatchObject({
      pageSize: 1,
      filterBy: 'pool_address=[tracked-pool]'
    });
    expect(vi.mocked(route.observe).mock.calls.map(([candidate]) => candidate.address)).toEqual([
      'tracked-pool', 'pool-1'
    ]);
  });

  it('does not overwrite fresh GMGN safety with a local batch deferral and prioritizes the deferred pool next tick', async () => {
    const writer = new MemoryWriter();
    const route = routeSource(true);
    const rotationState = { priorityCursor: 0, discoveryCursor: 0, deferredPoolAddresses: new Set<string>() };
    const firstRow = meteoraRow();

    await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: route,
      rotationState,
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [firstRow],
      fetchTokenSafetyBatchImpl: async () => [{
        mint: 'mint-1', safe: true, safetyScore: 80, maxScore: 120, holders: 2_000, bluechipPct: 1
      }],
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    const deferred = await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: route,
      rotationState,
      routeMaximumPoolsPerTick: 2,
      routeDiscoveryPoolsPerTick: 1,
      readPriorityPoolAddresses: async () => ['pool-1'],
      now: () => new Date('2026-06-21T10:00:15.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        firstRow,
        meteoraRow({ address: 'pool-2', baseMint: 'mint-2', baseSymbol: 'SECOND' })
      ],
      fetchTokenSafetyBatchImpl: async (mints) => mints.map((mint) => ({
        mint, safe: false, safetyScore: 0, maxScore: 120, error: GMGN_SAFETY_DEFERRED_ERROR
      })),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(deferred.openableCount).toBe(1);
    expect(writer.observations.get('new-token-v1:pool-1:mint-1')?.find((item) => item.source === 'gmgn')?.status).toBe('passed');
    expect(rotationState.deferredPoolAddresses).toEqual(new Set(['pool-1', 'pool-2']));

    vi.mocked(route.observe).mockClear();
    await runCandidateWorkerTick({
      strategy: 'new-token-v1',
      writer,
      routeSource: route,
      rotationState,
      routeMaximumPoolsPerTick: 2,
      routeDiscoveryPoolsPerTick: 1,
      readPriorityPoolAddresses: async () => ['pool-1'],
      now: () => new Date('2026-06-21T10:00:30.000Z'),
      fetchMeteoraPoolsImpl: async () => [
        firstRow,
        meteoraRow({ address: 'pool-2', baseMint: 'mint-2', baseSymbol: 'SECOND' })
      ],
      fetchTokenSafetyBatchImpl: async (mints) => mints.map((mint) => ({
        mint, safe: true, safetyScore: 80, maxScore: 120, holders: 2_000, bluechipPct: 1
      })),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(vi.mocked(route.observe).mock.calls.map(([candidate]) => candidate.address)).toEqual(['pool-1', 'pool-2']);
    expect(rotationState.deferredPoolAddresses).toEqual(new Set());
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
      ['meteora', 'pool_fee_yield'],
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

  it('keeps established pools with non-LP bin widths in the large-pool spot universe', async () => {
    const writer = new MemoryWriter();
    const route = routeSource(true);

    const result = await runCandidateWorkerTick({
      strategy: 'large-pool-v1',
      writer,
      routeSource: route,
      now: () => new Date('2026-06-21T10:00:00.000Z'),
      fetchMeteoraPoolsImpl: async () => [meteoraRow({
        address: 'established-large-pool',
        created_at: new Date('2025-01-01T00:00:00.000Z').getTime(),
        pool_config: { bin_step: 10, base_fee_pct: 0.05 }
      })],
      fetchTokenSafetyBatchImpl: async () => [],
      gmgnSourceMode: 'disabled',
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(result).toMatchObject({
      fetchedPoolCount: 1,
      prefilteredCount: 1,
      lpEligibleCount: 1
    });
    expect(route.observe).toHaveBeenCalledTimes(1);
  });
});
