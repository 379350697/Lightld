import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  CandidateSampleStore,
  resolveEvolutionPaths,
  type CandidateSampleRecord
} from '../../../src/evolution';

describe('resolveEvolutionPaths', () => {
  it('builds default strategy-scoped evolution artifact paths', () => {
    const paths = resolveEvolutionPaths('new-token-v1');

    expect(paths.rootDir).toBe('state/evolution/new-token-v1');
    expect(paths.candidateScansPath).toBe('state/evolution/new-token-v1/candidate-scans.jsonl');
    expect(paths.watchlistSnapshotsPath).toBe('state/evolution/new-token-v1/watchlist-snapshots.jsonl');
    expect(paths.watchlistTrackedTokensPath).toBe('state/evolution/new-token-v1/watchlist-tracked-tokens.json');
    expect(paths.positionOutcomesPath).toBe('state/evolution/new-token-v1/position-outcomes.jsonl');
    expect(paths.reportJsonPath).toBe('state/evolution/new-token-v1/evolution-report.json');
    expect(paths.reportMarkdownPath).toBe('state/evolution/new-token-v1/evolution-report.md');
    expect(paths.proposalCatalogPath).toBe('state/evolution/new-token-v1/proposal-catalog.json');
    expect(paths.approvalQueuePath).toBe('state/evolution/new-token-v1/approval-queue.json');
    expect(paths.approvedPatchesDir).toBe('state/evolution/new-token-v1/approved-patches');
  });
});

describe('CandidateSampleStore', () => {
  it('returns an empty array when no candidate sample file exists yet', async () => {
    const path = 'tmp/evolution/test-candidate-scans-empty.jsonl';
    await rm(path, { force: true });

    const store = new CandidateSampleStore(path);

    await expect(store.readAll()).resolves.toEqual([]);
  });

  it('appends and reads candidate samples in order', async () => {
    const path = 'tmp/evolution/test-candidate-scans.jsonl';
    await rm(path, { force: true });

    const store = new CandidateSampleStore(path);
    const first: CandidateSampleRecord = {
      sampleId: 'cand-1',
      capturedAt: '2026-04-18T00:00:00.000Z',
      strategyId: 'new-token-v1',
      cycleId: 'cycle-1',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      poolAddress: 'pool-safe',
      liquidityUsd: 12_500,
      holders: 48,
      safetyScore: 87,
      volume24h: 2_000_000,
      feeTvlRatio24h: 0.03,
      binStep: 120,
      hasInventory: false,
      hasLpPosition: false,
      selected: false,
      selectionRank: 2,
      blockedReason: 'selected-other-candidate',
      rejectionStage: 'selection',
      runtimeMode: 'healthy',
      sessionPhase: 'active'
    };
    const second: CandidateSampleRecord = {
      ...first,
      sampleId: 'cand-2',
      tokenMint: 'mint-best',
      tokenSymbol: 'BEST',
      poolAddress: 'pool-best',
      selected: true,
      selectionRank: 1,
      blockedReason: '',
      rejectionStage: 'none'
    };

    await store.append(first);
    await store.append(second);

    await expect(store.readAll()).resolves.toEqual([first, second]);
  });
});
