import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ExecutableMarkV2Store,
  ExperimentRegistryV2Store,
  OpportunityEpisodeV2Store,
  ValidationReportV2Store,
  type ExecutableMarkV2,
  type ExperimentRegistryV2,
  type OpportunityEpisodeV2,
  type ValidationReportV2
} from '../../../src/research-v2';

describe('research V2 immutable stores', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('makes appends idempotent and rejects conflicting records with the same immutable key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-research-v2-'));
    directories.push(root);
    const store = new OpportunityEpisodeV2Store(join(root, 'episodes.jsonl'));
    const episode = buildEpisode();

    await store.append(episode);
    await store.append(episode);

    expect(await store.readAll()).toEqual([episode]);
    await expect(store.append({ ...episode, tokenSymbol: 'CHANGED' })).rejects.toThrow(/immutable conflict/i);
  });

  it('enforces one immutable mark per episode and horizon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-research-v2-mark-'));
    directories.push(root);
    const store = new ExecutableMarkV2Store(join(root, 'marks.jsonl'));
    const mark = buildMark();

    await store.append(mark);
    await expect(store.append({
      ...mark,
      markId: 'different-mark-id',
      executableValueSol: 0.3
    })).rejects.toThrow(/episode and horizon/i);
  });

  it('keeps experiment registrations and validation reports append-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-research-v2-registry-'));
    directories.push(root);
    const experiments = new ExperimentRegistryV2Store(join(root, 'experiments.jsonl'));
    const reports = new ValidationReportV2Store(join(root, 'reports.jsonl'));
    const experiment = buildExperiment();
    const report = buildReport();

    await experiments.register(experiment);
    await reports.append(report);

    await expect(experiments.register({
      ...experiment,
      hypothesisId: 'hypothesis-insufficient-purge',
      validationWindow: {
        startsAt: '2026-03-01T12:00:00.000Z',
        endsAt: '2026-04-01T00:00:00.000Z'
      }
    })).rejects.toThrow(/registered purge/i);
    await expect(experiments.register({
      ...experiment,
      hypothesis: 'A changed hypothesis is forbidden.'
    })).rejects.toThrow(/immutable conflict/i);
    await expect(reports.append({
      ...report,
      datasetId: 'dataset-2'
    })).rejects.toThrow(/immutable conflict/i);
    expect(await experiments.readAll()).toEqual([experiment]);
    expect(await reports.readAll()).toEqual([report]);
  });
});

function buildEpisode(): OpportunityEpisodeV2 {
  return {
    schemaVersion: 2,
    episodeId: 'episode-1',
    capturedAt: '2026-07-01T00:00:00.000Z',
    labelWindowEndsAt: '2026-07-02T00:00:00.000Z',
    runId: 'run-1',
    strategyId: 'new-token-v1',
    tokenMint: 'mint-1',
    tokenSymbol: 'ONE',
    poolAddress: 'pool-1',
    deployerAddress: 'deployer-1',
    configSnapshotId: 'config-1',
    policyVariantId: 'policy-1',
    eligible: true,
    selected: true,
    hardRejectionReasons: [],
    softRejectionReasons: [],
    pointInTimeFeatures: { liquidityUsd: 10000 },
    sourceObservations: []
  };
}

function buildMark(): ExecutableMarkV2 {
  return {
    schemaVersion: 2,
    markId: 'mark-1',
    episodeId: 'episode-1',
    strategyId: 'new-token-v1',
    tokenMint: 'mint-1',
    poolAddress: 'pool-1',
    horizon: '1h',
    targetAt: '2026-07-01T01:00:00.000Z',
    observedAt: '2026-07-01T01:01:00.000Z',
    timingDeltaMs: 60000,
    toleranceMs: 300000,
    timingClassification: 'within_tolerance',
    markStatus: 'observed',
    routeStatus: 'available',
    executableValueSol: 0.2,
    recoveryValueSol: null,
    adverseReason: null,
    buyRouteAvailable: true,
    sellRouteAvailable: true,
    quoteSlot: 1,
    quoteAgeMs: 10,
    roundTripImpactBps: 20,
    capacityCurve: [{ inputSol: 0.01, outputSol: 0.0099, impactBps: 20 }]
  };
}

function buildExperiment(): ExperimentRegistryV2 {
  return {
    schemaVersion: 2,
    hypothesisId: 'hypothesis-1',
    strategyId: 'new-token-v1',
    hypothesis: 'Tighter safety gates improve after-cost OOS returns.',
    parameterFamily: 'safety-gates',
    treatmentVariants: ['control', 'strict'],
    minimumDetectableEffect: 0.02,
    powerTarget: 0.8,
    testedVariantCount: 2,
    trainWindow: { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-03-01T00:00:00.000Z' },
    validationWindow: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-04-01T00:00:00.000Z' },
    oosWindow: { startsAt: '2026-04-02T00:00:00.000Z', endsAt: '2026-05-01T00:00:00.000Z' },
    purgeHours: 24,
    embargoHours: 24,
    acceptanceMetrics: ['after_cost_oos_geometric_return_lower_95'],
    createdAt: '2026-01-01T00:00:00.000Z',
    locked: true
  };
}

function buildReport(): ValidationReportV2 {
  return {
    schemaVersion: 2,
    policyVersion: 'professional-v2',
    reportId: 'report-1',
    datasetId: 'dataset-1',
    hypothesisId: 'hypothesis-1',
    generatedAt: '2026-07-01T00:00:00.000Z',
    status: 'no_action',
    proposalAllowed: false,
    coverage: {
      independentEpisodes: 1,
      naturalDays: 1,
      untouchedOosEpisodes: 0,
      marketRegimes: 1,
      maxPoolEpisodeContributionPct: 100,
      maxPoolProfitContributionPct: 100,
      maxDeployerEpisodeContributionPct: 100
    },
    dataQuality: {
      datasetSchemaVersion: 2,
      identityMismatchCount: 0,
      duplicatedOutcomeBindingCount: 0,
      invalidV1RowCount: 0,
      untrustedValuationCount: 0,
      unknownTerminalOutcomeCount: 0,
      unreconciledLedgerDeltaSol: 0
    },
    metrics: null,
    blockingReasons: ['insufficient_independent_episodes']
  };
}
