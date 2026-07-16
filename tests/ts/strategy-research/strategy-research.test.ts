import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadStrategyConfig } from '../../../src/config/loader.ts';
import type { IngestCandidate } from '../../../src/runtime/ingest-candidate-selection.ts';
import { analyzeStrategyResearch } from '../../../src/strategy-research/analyzer.ts';
import { buildSnapshot } from '../../../src/strategy-research/capture.ts';
import { validateResearchSpecPatches } from '../../../src/strategy-research/spec.ts';
import { StrategyResearchStore } from '../../../src/strategy-research/store.ts';
import { StrategyResearchSpecSchema, type ResearchEpisode, type ResearchMark } from '../../../src/strategy-research/types.ts';
import { classifyQuoteFailure, runResearchWorkerTick, type ResearchMarkCollector } from '../../../src/strategy-research/worker.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('personal strategy research loop', () => {
  it('captures one market snapshot, isolates variant decisions and remains exploratory below hard review floors', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const store = new StrategyResearchStore(join(root, 'research.sqlite'));
    await store.open();
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = {
      experimentId: 'liquidity-filter-test',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      baseConfig: config,
      variants: [{ variantId: 'deeper-pools', parameterPatch: { filters: { minLiquidityUsd: 50_000 } } }],
      thresholds: { minimumEpisodes: 1, minimumUtcDays: 1, minimumOosEpisodes: 1, minimumMarkCoverage: 0.9 }
    };
    store.startExperiment(spec, '2026-07-01T00:00:00.000Z');
    const snapshot = buildSnapshot(spec, config, [
      candidate('pool-a', 'mint-a', 10_000, 0.2),
      candidate('pool-b', 'mint-b', 100_000, 0.1)
    ], '2026-07-01T00:00:00.000Z', 'mechanical-soak');
    store.captureSnapshot(snapshot);
    store.captureSnapshot(snapshot);
    store.captureSnapshot(buildSnapshot(spec, config, [
      candidate('pool-a', 'mint-a', 10_000, 0.2),
      candidate('pool-b', 'mint-b', 100_000, 0.1)
    ], '2026-07-01T01:00:00.000Z', 'mechanical-soak'));
    expect(store.recordPaperSelection({
      strategyId: 'new-token-v1', poolAddress: 'pool-a', tokenMint: 'mint-a',
      selectedAt: '2026-07-01T00:02:00.000Z', action: 'add-lp', reason: 'paper-open'
    })).toMatchObject({ variantId: 'baseline' });
    expect(store.recordPaperSelection({
      strategyId: 'new-token-v1', poolAddress: 'pool-a', tokenMint: 'mint-a',
      selectedAt: '2026-07-01T02:00:00.000Z', action: 'add-lp', reason: 'stale-snapshot'
    })).toBeNull();

    let markObservedAt = '2026-07-01T00:00:00.000Z';
    const collector: ResearchMarkCollector = {
      async collectEntry(episode) {
        return { status: 'ok', targetTokenRaw: '1000', doubleTokenRaw: '2000', targetImpactBps: 10, doubleImpactBps: 12 };
      },
      async collectMark(episode, horizonMinutes) {
        return mark(episode, horizonMinutes, episode.tokenMint === 'mint-b' ? 0.13 : 0.08, markObservedAt);
      }
    };
    for (const timestamp of [
      '2026-07-01T00:01:00.000Z',
      '2026-07-01T00:15:00.000Z',
      '2026-07-01T01:00:00.000Z',
      '2026-07-01T04:00:00.000Z',
      '2026-07-02T00:00:00.000Z'
    ]) {
      markObservedAt = timestamp;
      await runResearchWorkerTick({ store, collector, now: new Date(timestamp) });
    }

    const status = store.status();
    expect(status.snapshotCount).toBe(2);
    expect(status.selectedEpisodeCount).toBe(2);
    expect(status.marks).toEqual({ '15': 2, '60': 2, '240': 2, '1440': 2 });
    const report = analyzeStrategyResearch(store, spec);
    expect(report.status).toBe('insufficient');
    expect(report.blockingReasons).toContain('minimum_episodes_not_met');
    expect(report.chosenVariant).toBeNull();
    expect(report.patchDraft).toBeNull();
    store.close();
  });

  it('keeps unavailable evidence separate and rejects non-strategy patches', async () => {
    expect(() => validateResearchSpecPatches({
      experimentId: 'bad',
      strategyId: 'new-token-v1',
      positionSol: 0.1,
      variants: [{ variantId: 'bad', parameterPatch: { live: { enabled: false } } }],
      thresholds: { minimumEpisodes: 1, minimumUtcDays: 1, minimumOosEpisodes: 1, minimumMarkCoverage: 0.9 }
    })).toThrow('not allowed');
    expect(() => validateResearchSpecPatches({
      experimentId: 'misleading',
      strategyId: 'new-token-v1',
      positionSol: 0.1,
      variants: [{ variantId: 'daily-loss', parameterPatch: { riskThresholds: { maxDailyLossSol: 10 } } }],
      thresholds: { minimumEpisodes: 1, minimumUtcDays: 1, minimumOosEpisodes: 1, minimumMarkCoverage: 0.9 }
    })).toThrow('not allowed');
  });

  it('imports only mechanical-soak outcomes recorded after the experiment starts', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-outcomes-${process.pid}-${Date.now()}`);
    roots.push(root);
    const store = new StrategyResearchStore(join(root, 'research.sqlite'));
    await store.open();
    const spec = {
      experimentId: 'paper-isolation',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      variants: [{ variantId: 'test', parameterPatch: { filters: { minLiquidityUsd: 50_000 } } }],
      thresholds: { minimumEpisodes: 1, minimumUtcDays: 1, minimumOosEpisodes: 1, minimumMarkCoverage: 0.9 }
    };
    store.startExperiment(spec, '2026-07-01T00:00:00.000Z');
    store.stopExperiment('2026-07-02T12:00:00.000Z');
    const outcome = {
      cycleId: 'cycle-paper', strategyId: 'new-token-v1' as const, recordedAt: '2026-07-02T00:00:00.000Z',
      tokenMint: 'mint', tokenSymbol: 'MINT', poolAddress: 'pool', runtimeMode: 'healthy', sessionPhase: 'closed' as const,
      action: 'withdraw-lp' as const, actualExitReason: 'take-profit', liveOrderSubmitted: false,
      entrySol: 0.1, exitMetrics: { requestedPositionSol: 0.1, lpTotalValueSol: 0.11 },
      parameterSnapshot: { lpEnabled: true, maxHoldHours: 18 }
    };
    store.syncPaperOutcomes(spec.experimentId, [
      { ...outcome, captureMode: 'live' },
      { ...outcome, cycleId: 'cycle-shadow', captureMode: 'economic-shadow' },
      { ...outcome, cycleId: 'cycle-paper', captureMode: 'mechanical-soak' },
      { ...outcome, cycleId: 'cycle-after-stop', recordedAt: '2026-07-03T00:00:00.000Z', captureMode: 'mechanical-soak' }
    ]);
    expect(store.status().paperOutcomeCount).toBe(1);
    store.close();
  });

  it('counts no-route as a business loss while keeping source unavailability retryable', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-failures-${process.pid}-${Date.now()}`);
    roots.push(root);
    const store = new StrategyResearchStore(join(root, 'research.sqlite'));
    await store.open();
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = {
      experimentId: 'failure-semantics',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      baseConfig: config,
      variants: [{ variantId: 'same-policy', parameterPatch: { filters: { minLiquidityUsd: 1000 } } }],
      thresholds: { minimumEpisodes: 1, minimumUtcDays: 1, minimumOosEpisodes: 1, minimumMarkCoverage: 0.9 }
    };
    store.startExperiment(spec, '2026-07-01T00:00:00.000Z');
    store.captureSnapshot(buildSnapshot(spec, config, [candidate('pool-fail', 'mint-fail', 100_000, 0.1)], '2026-07-01T00:00:00.000Z', 'mechanical-soak'));
    await runResearchWorkerTick({
      store,
      now: new Date('2026-07-01T00:01:00.000Z'),
      collector: {
        async collectEntry() { return { status: 'no_route', detail: 'confirmed-no-route' }; },
        async collectMark(episode, horizonMinutes) { return mark(episode, horizonMinutes, 0); }
      }
    });
    expect(store.listEpisodes(spec.experimentId).every((episode) => episode.entryStatus === 'no_route')).toBe(true);
    const report = analyzeStrategyResearch(store, spec);
    expect(report.variants.every((variant) => variant.totalPnlSol === -0.1)).toBe(true);

    const unavailableSpec = { ...spec, experimentId: 'unavailable-semantics' };
    store.startExperiment(unavailableSpec, '2026-07-02T00:00:00.000Z');
    store.captureSnapshot(buildSnapshot(unavailableSpec, config, [candidate('pool-down', 'mint-down', 100_000, 0.1)], '2026-07-02T00:00:00.000Z', 'mechanical-soak'));
    const worker = await runResearchWorkerTick({
      store,
      now: new Date('2026-07-02T00:01:00.000Z'),
      collector: {
        async collectEntry() { return { status: 'unavailable', detail: 'provider-timeout' }; },
        async collectMark(episode, horizonMinutes) { return mark(episode, horizonMinutes, 0); }
      }
    });
    expect(worker.unavailable).toBe(1);
    expect(store.dueEpisodes(new Date('2026-07-02T00:02:00.000Z')).length).toBe(1);
    store.close();
  });

  it('fails late marks closed, stops scheduling stopped experiments and enforces review floors', async () => {
    expect(() => StrategyResearchSpecSchema.parse({
      experimentId: 'too-small',
      strategyId: 'new-token-v1',
      variants: [{ variantId: 'variant', parameterPatch: { filters: { minLiquidityUsd: 2000 } } }],
      thresholds: { minimumEpisodes: 1, minimumUtcDays: 1, minimumOosEpisodes: 1, minimumMarkCoverage: 0.5 }
    })).toThrow();

    const root = join(process.cwd(), `.tmp-strategy-research-late-${process.pid}-${Date.now()}`);
    roots.push(root);
    const store = new StrategyResearchStore(join(root, 'research.sqlite'));
    await store.open();
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = {
      experimentId: 'late-marks',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      baseConfig: config,
      variants: [{ variantId: 'same', parameterPatch: { filters: { minLiquidityUsd: 1000 } } }],
      thresholds: { minimumEpisodes: 50, minimumUtcDays: 7, minimumOosEpisodes: 15, minimumMarkCoverage: 0.9 }
    };
    store.startExperiment(spec, '2026-07-01T00:00:00.000Z');
    store.captureSnapshot(buildSnapshot(spec, config, [candidate('pool-late', 'mint-late', 100_000, 0.1)], '2026-07-01T00:00:00.000Z', 'mechanical-soak'));
    let collectorCalls = 0;
    await runResearchWorkerTick({
      store,
      now: new Date('2026-07-01T00:06:00.000Z'),
      collector: {
        async collectEntry() { collectorCalls += 1; return { status: 'ok', targetTokenRaw: '1', doubleTokenRaw: '2' }; },
        async collectMark(episode, horizonMinutes) { collectorCalls += 1; return mark(episode, horizonMinutes, 0.1); }
      }
    });
    expect(collectorCalls).toBe(0);
    expect(store.listEpisodes(spec.experimentId).every((episode) => episode.entryStatus === 'missed')).toBe(true);
    store.stopExperiment('2026-07-01T00:07:00.000Z');
    expect(store.dueEpisodes(new Date('2026-07-03T00:00:00.000Z'))).toEqual([]);
    store.close();
  });

  it('classifies business terminal quote failures separately from provider outages', () => {
    expect(classifyQuoteFailure(new Error('pool closed: insufficient liquidity')).status).toBe('dead_pool');
    expect(classifyQuoteFailure(new Error('honeypot / freeze authority detected')).status).toBe('rug');
    expect(classifyQuoteFailure(new Error('upstream timeout')).status).toBe('unavailable');
  });
});

function candidate(address: string, mint: string, liquidityUsd: number, feeTvlRatio24h: number): IngestCandidate {
  return {
    address,
    mint,
    symbol: mint,
    quoteMint: 'So11111111111111111111111111111111111111112',
    liquidityUsd,
    hasSolRoute: true,
    capturedAt: '2026-06-30T00:00:00.000Z',
    holders: 100,
    hasInventory: false,
    hasLpPosition: false,
    binStep: 100,
    baseFeePct: 1,
    volume24h: 200_000,
    feeTvlRatio24h
  };
}

function mark(
  episode: ResearchEpisode,
  horizonMinutes: 15 | 60 | 240 | 1440,
  recovery: number,
  observedAt = '2026-07-03T00:00:00.000Z'
): ResearchMark {
  return {
    episodeId: episode.episodeId,
    horizonMinutes,
    observedAt,
    status: 'ok',
    targetRecoverySol: recovery,
    doubleRecoverySol: recovery * 2,
    targetImpactBps: 10,
    doubleImpactBps: 12,
    detail: ''
  };
}
