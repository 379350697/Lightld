import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { loadStrategyConfig } from '../../../src/config/loader.ts';
import { LiveCycleOutcomeRecordArraySchema } from '../../../src/evolution/types.ts';
import { JupiterNoRouteError } from '../../../src/execution/solana/jupiter-client.ts';
import type { IngestCandidate } from '../../../src/runtime/ingest-candidate-selection.ts';
import { analyzeStrategyResearch, renderResearchMarkdown } from '../../../src/strategy-research/analyzer.ts';
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
    expect(() => store.captureSnapshot({
      ...snapshot,
      decisions: snapshot.decisions.map((decision, index) => index === 0 ? { ...decision, reason: 'conflict' } : decision)
    })).toThrow('Conflicting research decision');
    store.captureSnapshot(buildSnapshot(spec, config, [
      candidate('pool-a', 'mint-a', 10_000, 0.2),
      candidate('pool-b', 'mint-b', 100_000, 0.1)
    ], '2026-07-01T01:00:00.000Z', 'mechanical-soak'));
    expect(store.recordPaperSelection({
      strategyId: 'new-token-v1', poolAddress: 'pool-a', tokenMint: 'mint-a',
      selectedAt: '2026-07-01T00:02:00.000Z', action: 'add-lp', reason: 'paper-open'
    })).toMatchObject({ variantId: 'baseline' });
    expect(store.recordPaperSelection({
      strategyId: 'new-token-v1', poolAddress: 'pool-b', tokenMint: 'mint-b',
      selectedAt: '2026-07-01T00:03:00.000Z', action: 'add-lp', reason: 'variant-only-candidate'
    })).toBeNull();
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
      '2026-07-01T08:00:00.000Z',
      '2026-07-02T00:00:00.000Z'
    ]) {
      markObservedAt = timestamp;
      await runResearchWorkerTick({ store, collector, now: new Date(timestamp) });
    }

    const status = store.status();
    expect(status.snapshotCount).toBe(2);
    expect(status.selectedEpisodeCount).toBe(2);
    expect(status.marks).toEqual({ '15': 2, '60': 2, '240': 2, '480': 2, '1440': 2 });
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

  it('rejects variants that would need candidates excluded by the locked baseline universe', async () => {
    const baseConfig = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = (variantId: string, parameterPatch: Record<string, unknown>) => ({
      experimentId: 'candidate-universe-guard',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      baseConfig,
      variants: [{ variantId, parameterPatch }],
      thresholds: { minimumEpisodes: 50, minimumUtcDays: 7, minimumOosEpisodes: 15, minimumMarkCoverage: 0.9 }
    });

    for (const [variantId, parameterPatch, path] of [
      ['lower-liquidity', { filters: { minLiquidityUsd: baseConfig.filters.minLiquidityUsd - 1 } }, 'filters.minLiquidityUsd'],
      ['lower-bin-step', { lpConfig: { minBinStep: baseConfig.lpConfig!.minBinStep - 1 } }, 'lpConfig.minBinStep'],
      ['lower-volume', { lpConfig: { minVolume24hUsd: baseConfig.lpConfig!.minVolume24hUsd - 1 } }, 'lpConfig.minVolume24hUsd'],
      ['lower-fee-yield', { lpConfig: { minFeeTvlRatio24h: baseConfig.lpConfig!.minFeeTvlRatio24h / 2 } }, 'lpConfig.minFeeTvlRatio24h'],
      ['disable-lp', { lpConfig: { enabled: false } }, 'lpConfig.enabled']
    ] as const) {
      expect(() => validateResearchSpecPatches(spec(variantId, parameterPatch)))
        .toThrow(new RegExp(`expands the baseline candidate universe at ${path.replaceAll('.', '\\.')}`));
    }

    const disabledLpBase = {
      ...baseConfig,
      lpConfig: { ...baseConfig.lpConfig!, enabled: false }
    };
    expect(() => validateResearchSpecPatches({
      ...spec('enable-lp', { lpConfig: { enabled: true } }),
      baseConfig: disabledLpBase
    })).toThrow(/expands the baseline candidate universe at lpConfig\.enabled/);

    const noLpBase = await loadStrategyConfig('src/config/strategies/large-pool-v1.yaml');
    expect(() => validateResearchSpecPatches({
      ...spec('enable-missing-lp', { lpConfig: { enabled: true } }),
      strategyId: 'large-pool-v1',
      baseConfig: noLpBase
    })).toThrow(/expands the baseline candidate universe at lpConfig\.enabled/);

    expect(() => validateResearchSpecPatches(spec('current-quality-variants', {
      filters: { minLiquidityUsd: 5_000 },
      lpConfig: { minBinStep: 100, minVolume24hUsd: 150_000 },
      riskThresholds: { maxPositionSol: 0.1 },
      entryEdge: { defaultSafetyMarginBps: 20 }
    }))).not.toThrow();
  });

  it('imports only mechanical-soak outcomes recorded after the experiment starts', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-outcomes-${process.pid}-${Date.now()}`);
    roots.push(root);
    const store = new StrategyResearchStore(join(root, 'research.sqlite'));
    await store.open();
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = {
      experimentId: 'paper-isolation',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      baseConfig: config,
      variants: [{ variantId: 'test', parameterPatch: { filters: { minLiquidityUsd: 50_000 } } }],
      thresholds: { minimumEpisodes: 1, minimumUtcDays: 1, minimumOosEpisodes: 1, minimumMarkCoverage: 0.9 }
    };
    store.startExperiment(spec, '2026-07-01T00:00:00.000Z');
    store.captureSnapshot(buildSnapshot(
      spec,
      config,
      [candidate('pool', 'mint', 100_000, 0.1)],
      '2026-07-01T00:00:00.000Z',
      'mechanical-soak'
    ));
    expect(store.recordPaperSelection({
      strategyId: 'new-token-v1', poolAddress: 'pool', tokenMint: 'mint',
      selectedAt: '2026-07-01T00:02:00.000Z', action: 'add-lp', reason: 'paper-open'
    })).not.toBeNull();
    store.stopExperiment('2026-07-02T12:00:00.000Z');
    const outcome = {
      cycleId: 'cycle-paper', strategyId: 'new-token-v1' as const, recordedAt: '2026-07-02T00:00:00.000Z',
      tokenMint: 'mint', tokenSymbol: 'MINT', poolAddress: 'pool', runtimeMode: 'healthy', sessionPhase: 'closed' as const,
      action: 'withdraw-lp' as const, actualExitReason: 'take-profit', liveOrderSubmitted: false,
      entrySol: 0.1,
      exitMetrics: {
        requestedPositionSol: 0.1,
        lpTotalValueSol: 0.11,
        valuationTrust: 'fallback_display' as const,
        valuationCompleteness: 'untrusted' as const
      },
      parameterSnapshot: { lpEnabled: true, maxHoldHours: 18 }
    };
    store.syncPaperOutcomes(spec.experimentId, LiveCycleOutcomeRecordArraySchema.parse([
      { ...outcome, captureMode: 'live' },
      { ...outcome, cycleId: 'cycle-shadow', captureMode: 'economic-shadow' },
      { ...outcome, cycleId: 'cycle-paper', captureMode: 'mechanical-soak' },
      {
        ...outcome,
        cycleId: 'cycle-paper-bound',
        openedAt: '2026-07-01T00:03:00.000Z',
        recordedAt: '2026-07-01T00:10:00.000Z',
        captureMode: 'mechanical-soak',
        action: 'dca-out' as const,
        exitMetrics: {
          requestedPositionSol: 0.1,
          quoteOutputSol: 0.11,
          settlementEvidence: 'paper-executable-spot-quote' as const
        }
      },
      {
        ...outcome,
        cycleId: 'cycle-paper-closed-after-stop',
        openedAt: '2026-07-01T00:04:00.000Z',
        recordedAt: '2026-07-03T00:00:00.000Z',
        closedAt: '2026-07-03T00:00:00.000Z',
        captureMode: 'mechanical-soak',
        exitMetrics: {
          requestedPositionSol: 0.1,
          lpTotalValueSol: 0.13,
          lpTradingValueSol: 0.11,
          lpEntryTradingSol: 0.09,
          lpClaimedFeeValueSol: 0.02,
          valuationTrust: 'exit_quote',
          valuationCompleteness: 'complete'
        }
      },
      { ...outcome, cycleId: 'cycle-after-stop', recordedAt: '2026-07-03T00:00:00.000Z', captureMode: 'mechanical-soak' }
    ]));
    expect(store.status()).toMatchObject({
      paperOutcomeCount: 3,
      boundPaperOutcomeCount: 2,
      paperExecutablePnlCount: 1,
      boundPaperExecutablePnlCount: 1
    });
    const paperOutcomes = store.paperOutcomes(spec.experimentId);
    expect(paperOutcomes.map((row) => row.selectionId === null)).toEqual([false, true, false]);
    expect(paperOutcomes.find((row) => row.pnlEvidenceKind === 'paper-executable-spot-quote')?.pnlSol).toBeCloseTo(0.01, 9);
    expect(paperOutcomes.filter((row) => row.pnlEvidenceKind === 'lifecycle-only').map((row) => row.pnlSol))
      .toEqual([null, null]);
    const report = analyzeStrategyResearch(store, spec);
    expect(report.sample).toMatchObject({
      paperLifecycleClosureCount: 3,
      boundPaperLifecycleClosureCount: 2,
      paperExecutablePnlCount: 1,
      boundPaperExecutablePnlCount: 1
    });
    expect(report.paperExecutablePnl.count).toBe(1);
    expect(report.paperExecutablePnl.totalPnlSol).toBeCloseTo(0.01, 9);
    expect(report).not.toHaveProperty('paperRealized');
    expect(renderResearchMarkdown(report)).not.toContain('realized');
    store.close();
  });

  it('fails closed when migrating legacy paper PnL that has no valuation trust evidence', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-legacy-pnl-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const path = join(root, 'research.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE paper_outcomes (
        outcome_id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        opened_at TEXT,
        closed_at TEXT,
        runtime_mode TEXT NOT NULL,
        capture_mode TEXT NOT NULL DEFAULT 'unknown',
        selection_id TEXT,
        snapshot_id TEXT,
        variant_id TEXT,
        entry_sol REAL,
        exit_value_sol REAL,
        fee_value_sol REAL,
        pnl_sol REAL,
        raw_json TEXT NOT NULL
      );
      INSERT INTO paper_outcomes VALUES(
        'legacy-outcome','legacy-experiment','new-token-v1','2026-07-01T00:00:00.000Z',NULL,NULL,
        'healthy','mechanical-soak',NULL,NULL,NULL,0.1,0.2,0,0.1,'{}'
      );
    `);
    legacy.close();

    const readOnlyStore = new StrategyResearchStore(path, true);
    await readOnlyStore.open();
    const readOnlyRows = readOnlyStore.paperOutcomes('legacy-experiment');
    readOnlyStore.close();
    expect(readOnlyRows).toEqual([expect.objectContaining({
      pnlSol: null,
      pnlEvidenceKind: 'legacy-untrusted'
    })]);

    const store = new StrategyResearchStore(path);
    await store.open();
    const rows = store.paperOutcomes('legacy-experiment');
    store.close();

    expect(rows).toEqual([expect.objectContaining({
      pnlSol: null,
      pnlEvidenceKind: 'legacy-untrusted'
    })]);
  });

  it('counts a failed entry as no trade while keeping source unavailability retryable', async () => {
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
    expect(report.variants.every((variant) => variant.totalPnlSol === 0)).toBe(true);
    expect(report.sample.markCoverage).toBe(1);

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
    expect(worker.unavailable).toBe(2);
    expect(store.dueEpisodes(new Date('2026-07-02T00:02:00.000Z')).length).toBe(2);
    store.close();
  });

  it('does not turn a temporary intermediate no-route mark into a total capital loss', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-route-gap-${process.pid}-${Date.now()}`);
    roots.push(root);
    const store = new StrategyResearchStore(join(root, 'research.sqlite'));
    await store.open();
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = {
      experimentId: 'temporary-route-gap',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      baseConfig: config,
      variants: [{ variantId: 'same', parameterPatch: { filters: { minLiquidityUsd: 1000 } } }],
      thresholds: { minimumEpisodes: 50, minimumUtcDays: 7, minimumOosEpisodes: 15, minimumMarkCoverage: 0.9 }
    };
    store.startExperiment(spec, '2026-07-01T00:00:00.000Z');
    store.captureSnapshot(buildSnapshot(
      spec,
      config,
      [candidate('pool-gap', 'mint-gap', 100_000, 0.1)],
      '2026-07-01T00:00:00.000Z',
      'mechanical-soak'
    ));
    for (const episode of store.listEpisodes(spec.experimentId)) {
      store.recordEntryQuote({ episodeId: episode.episodeId, status: 'ok', targetTokenRaw: '1000', doubleTokenRaw: '2000' });
      store.recordMark({
        ...mark(episode, 15, 0, '2026-07-01T00:15:00.000Z'),
        status: 'no_route', targetRecoverySol: null, doubleRecoverySol: null
      });
      for (const [horizon, observedAt] of [
        [60, '2026-07-01T01:00:00.000Z'],
        [240, '2026-07-01T04:00:00.000Z'],
        [480, '2026-07-01T08:00:00.000Z'],
        [1440, '2026-07-02T00:00:00.000Z']
      ] as const) {
        store.recordMark(mark(episode, horizon, 0.11, observedAt));
      }
    }
    const report = analyzeStrategyResearch(store, spec);
    expect(report.variants.every((variant) => variant.totalPnlSol > 0)).toBe(true);
    store.close();
  });

  it('uses the same conservative round-trip slippage in research eligibility as the live engine', async () => {
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = {
      experimentId: 'edge-consistency',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      baseConfig: config,
      variants: [{ variantId: 'same', parameterPatch: { filters: { minLiquidityUsd: 1000 } } }],
      thresholds: { minimumEpisodes: 50, minimumUtcDays: 7, minimumOosEpisodes: 15, minimumMarkCoverage: 0.9 }
    };
    const snapshot = buildSnapshot(
      spec,
      config,
      [candidate('pool-edge', 'mint-edge', 100_000, 0.02)],
      '2026-07-01T00:00:00.000Z',
      'mechanical-soak'
    );
    expect(snapshot.decisions.every((decision) => !decision.eligible && !decision.selected)).toBe(true);
  });

  it('preserves daemon database priority when choosing the baseline candidate', async () => {
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = {
      experimentId: 'daemon-order-consistency',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      baseConfig: config,
      variants: [{ variantId: 'same', parameterPatch: { filters: { minLiquidityUsd: 1000 } } }],
      thresholds: { minimumEpisodes: 50, minimumUtcDays: 7, minimumOosEpisodes: 15, minimumMarkCoverage: 0.9 }
    };
    const snapshot = buildSnapshot(spec, config, [
      candidate('database-first', 'mint-first', 10_000, 0.2),
      candidate('secondary', 'mint-secondary', 1_000_000, 0.2)
    ], '2026-07-01T00:00:00.000Z', 'mechanical-soak');

    expect(snapshot.decisions.find((decision) => decision.variantId === 'baseline' && decision.selected)).toMatchObject({
      poolAddress: 'database-first',
      tokenMint: 'mint-first'
    });
  });

  it('pairs an explicit no-action policy decision with the baseline trade instead of dropping the snapshot', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-no-action-${process.pid}-${Date.now()}`);
    roots.push(root);
    const store = new StrategyResearchStore(join(root, 'research.sqlite'));
    await store.open();
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = {
      experimentId: 'no-action-pairing',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.1,
      baseConfig: config,
      variants: [{
        variantId: 'strict-liquidity',
        parameterPatch: {
          hardGates: { minLiquidityUsd: 50_000 },
          filters: { minLiquidityUsd: 50_000 }
        }
      }],
      thresholds: { minimumEpisodes: 50, minimumUtcDays: 7, minimumOosEpisodes: 15, minimumMarkCoverage: 0.9 }
    };
    store.startExperiment(spec, '2026-07-01T00:00:00.000Z');
    store.captureSnapshot(buildSnapshot(
      spec,
      config,
      [candidate('pool-no-action', 'mint-no-action', 10_000, 0.1)],
      '2026-07-01T00:00:00.000Z',
      'mechanical-soak'
    ));
    const episode = store.listEpisodes(spec.experimentId)[0]!;
    expect(episode.variantId).toBe('baseline');
    store.recordEntryQuote({
      episodeId: episode.episodeId,
      status: 'ok',
      targetTokenRaw: '1000',
      doubleTokenRaw: '2000',
      targetImpactBps: 10,
      doubleImpactBps: 12
    });
    for (const [horizon, observedAt] of [
      [15, '2026-07-01T00:15:00.000Z'],
      [60, '2026-07-01T01:00:00.000Z'],
      [240, '2026-07-01T04:00:00.000Z'],
      [480, '2026-07-01T08:00:00.000Z'],
      [1440, '2026-07-02T00:00:00.000Z']
    ] as const) {
      store.recordMark(mark(episode, horizon, 0.05, observedAt));
    }

    const report = analyzeStrategyResearch(store, spec);
    expect(report.comparisons[0]).toMatchObject({ variantId: 'strict-liquidity', pairCount: 1 });
    expect(report.comparisons[0]!.bootstrap.mean).toBeGreaterThan(0);
    expect(report.variants.find((variant) => variant.variantId === 'strict-liquidity')).toMatchObject({
      count: 1,
      totalPnlSol: 0
    });
    store.close();
  });

  it('does not credit LP fees or charge impermanent loss to the large-pool spot strategy', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-large-pool-${process.pid}-${Date.now()}`);
    roots.push(root);
    const store = new StrategyResearchStore(join(root, 'research.sqlite'));
    await store.open();
    const config = await loadStrategyConfig('src/config/strategies/large-pool-v1.yaml');
    const spec = {
      experimentId: 'large-pool-spot-costs',
      strategyId: 'large-pool-v1' as const,
      positionSol: 0.1,
      baseConfig: config,
      variants: [{ variantId: 'deeper', parameterPatch: { filters: { minLiquidityUsd: 25_000 } } }],
      thresholds: { minimumEpisodes: 50, minimumUtcDays: 7, minimumOosEpisodes: 15, minimumMarkCoverage: 0.9 }
    };
    store.startExperiment(spec, '2026-07-01T00:00:00.000Z');
    store.captureSnapshot(buildSnapshot(
      spec,
      config,
      [candidate('pool-large', 'mint-large', 100_000, 0.2)],
      '2026-07-01T00:00:00.000Z',
      'mechanical-soak'
    ));
    for (const episode of store.listEpisodes(spec.experimentId)) {
      store.recordEntryQuote({
        episodeId: episode.episodeId,
        status: 'ok',
        targetTokenRaw: '1000',
        doubleTokenRaw: '2000',
        targetImpactBps: 10,
        doubleImpactBps: 12
      });
      for (const [horizon, observedAt] of [
        [15, '2026-07-01T00:15:00.000Z'],
        [60, '2026-07-01T01:00:00.000Z'],
        [240, '2026-07-01T04:00:00.000Z'],
        [480, '2026-07-01T08:00:00.000Z'],
        [1440, '2026-07-02T00:00:00.000Z']
      ] as const) {
        store.recordMark(mark(episode, horizon, 0.11, observedAt));
      }
    }

    const report = analyzeStrategyResearch(store, spec);
    expect(report.variants).toHaveLength(2);
    for (const variant of report.variants) {
      expect(variant.averageCosts.estimatedFeeSol).toBe(0);
      expect(variant.averageCosts.impermanentLossSol).toBe(0);
    }
    store.close();
  });

  it('collects entry quotes and marks independently for variants with different position sizes', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-size-isolation-${process.pid}-${Date.now()}`);
    roots.push(root);
    const store = new StrategyResearchStore(join(root, 'research.sqlite'));
    await store.open();
    const config = await loadStrategyConfig('src/config/strategies/new-token-v1.yaml');
    const spec = {
      experimentId: 'position-size-isolation',
      strategyId: 'new-token-v1' as const,
      positionSol: 0.5,
      baseConfig: config,
      variants: [{
        variantId: 'quarter-sol',
        parameterPatch: { riskThresholds: { maxPositionSol: 0.25 } }
      }],
      thresholds: { minimumEpisodes: 50, minimumUtcDays: 7, minimumOosEpisodes: 15, minimumMarkCoverage: 0.9 }
    };
    store.startExperiment(spec, '2026-07-01T00:00:00.000Z');
    store.captureSnapshot(buildSnapshot(
      spec,
      config,
      [candidate('pool-size', 'mint-size', 100_000, 0.1)],
      '2026-07-01T00:00:00.000Z',
      'mechanical-soak'
    ));

    const entryCalls: Array<{ episodeId: string; positionSol: number }> = [];
    const markCalls: Array<{ episodeId: string; positionSol: number }> = [];
    const collector: ResearchMarkCollector = {
      async collectEntry(episode) {
        entryCalls.push({ episodeId: episode.episodeId, positionSol: episode.positionSol });
        const targetTokenRaw = String(Math.round(episode.positionSol * 1_000_000));
        return {
          status: 'ok',
          targetTokenRaw,
          doubleTokenRaw: String(Number(targetTokenRaw) * 2),
          targetImpactBps: episode.positionSol * 100,
          doubleImpactBps: episode.positionSol * 200
        };
      },
      async collectMark(episode, horizonMinutes) {
        markCalls.push({ episodeId: episode.episodeId, positionSol: episode.positionSol });
        return mark(
          episode,
          horizonMinutes,
          episode.positionSol * 1.1,
          '2026-07-01T00:15:00.000Z'
        );
      }
    };

    await runResearchWorkerTick({
      store,
      collector,
      now: new Date('2026-07-01T00:01:00.000Z')
    });

    const episodes = store.listEpisodes(spec.experimentId);
    expect(episodes).toHaveLength(2);
    expect(entryCalls.map((call) => call.positionSol).sort()).toEqual([0.25, 0.5]);
    expect(new Set(entryCalls.map((call) => call.episodeId)).size).toBe(2);
    expect(Object.fromEntries(episodes.map((episode) => [episode.variantId, {
      positionSol: episode.positionSol,
      targetTokenRaw: episode.targetTokenRaw,
      doubleTokenRaw: episode.doubleTokenRaw
    }]))).toEqual({
      baseline: { positionSol: 0.5, targetTokenRaw: '500000', doubleTokenRaw: '1000000' },
      'quarter-sol': { positionSol: 0.25, targetTokenRaw: '250000', doubleTokenRaw: '500000' }
    });

    await runResearchWorkerTick({
      store,
      collector,
      now: new Date('2026-07-01T00:15:00.000Z')
    });

    const marks = store.listMarks(spec.experimentId);
    const episodeById = new Map(episodes.map((episode) => [episode.episodeId, episode]));
    expect(markCalls.map((call) => call.positionSol).sort()).toEqual([0.25, 0.5]);
    expect(new Set(markCalls.map((call) => call.episodeId)).size).toBe(2);
    expect(Object.fromEntries(marks.map((entry) => [
      episodeById.get(entry.episodeId)!.variantId,
      entry.targetRecoverySol
    ]))).toEqual({
      baseline: 0.55,
      'quarter-sol': 0.275
    });
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
    expect(() => store.startExperiment(spec, '2026-07-01T00:08:00.000Z')).toThrow('start a new experiment ID');
    expect(() => store.captureSnapshot(buildSnapshot(
      spec,
      config,
      [candidate('pool-after-stop', 'mint-after-stop', 100_000, 0.1)],
      '2026-07-01T01:00:00.000Z',
      'mechanical-soak'
    ))).toThrow('is not active');
    const episode = store.listEpisodes(spec.experimentId)[0]!;
    store.recordMark(mark(episode, 15, 0.1, '2026-07-01T00:15:00.000Z'));
    expect(store.listMarks(spec.experimentId)).toEqual([]);
    store.close();
  });

  it('can degrade research storage without preventing its caller from continuing', async () => {
    const root = join(process.cwd(), `.tmp-strategy-research-open-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const warnings: string[] = [];
    const store = new StrategyResearchStore(root);
    expect(await store.openBestEffort({ warn: (message) => warnings.push(String(message)) })).toBe(false);
    expect(warnings[0]).toContain('Strategy research disabled');
  });

  it('classifies business terminal quote failures separately from provider outages', () => {
    expect(classifyQuoteFailure(new JupiterNoRouteError('insufficient liquidity', 'NO_ROUTES_FOUND', 400)).status).toBe('no_route');
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
  horizonMinutes: ResearchMark['horizonMinutes'],
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
