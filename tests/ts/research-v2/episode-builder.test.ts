import { describe, expect, it } from 'vitest';

import {
  buildNonOverlappingOpportunityEpisodes,
  type CandidateOpportunityObservationV2
} from '../../../src/research-v2';

function observation(
  observedAt: string,
  overrides: Partial<CandidateOpportunityObservationV2> = {}
): CandidateOpportunityObservationV2 {
  return {
    observationId: `observation-${observedAt}`,
    observedAt,
    runId: 'run-1',
    strategyId: 'new-token-v1',
    tokenMint: 'mint-1',
    tokenSymbol: 'ONE',
    poolAddress: 'pool-1',
    deployerAddress: 'deployer-1',
    configSnapshotId: 'config-1',
    policyVariantId: 'policy-20-30',
    eligible: true,
    selected: true,
    hardRejectionReasons: [],
    softRejectionReasons: [],
    pointInTimeFeatures: {
      liquidityUsd: 25_000,
      feeTvlRatio24h: 0.03
    },
    sourceObservations: [
      {
        source: 'gmgn',
        status: 'passed',
        observedAt,
        freshnessMs: 0,
        details: {}
      }
    ],
    ...overrides
  };
}

describe('buildNonOverlappingOpportunityEpisodes', () => {
  it('creates at most one episode per pool and mint during the 24 hour label window', () => {
    const episodes = buildNonOverlappingOpportunityEpisodes([
      observation('2026-07-01T00:00:00.000Z'),
      observation('2026-07-01T06:00:00.000Z', { observationId: 'duplicate-6h' }),
      observation('2026-07-01T23:59:59.999Z', { observationId: 'duplicate-24h' })
    ]);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      schemaVersion: 2,
      capturedAt: '2026-07-01T00:00:00.000Z',
      labelWindowEndsAt: '2026-07-02T00:00:00.000Z',
      tokenMint: 'mint-1',
      poolAddress: 'pool-1',
      selected: true
    });
  });

  it('requires the prior window to finish and one continuous hour of ineligibility before a new episode', () => {
    const episodes = buildNonOverlappingOpportunityEpisodes([
      observation('2026-07-01T00:00:00.000Z'),
      observation('2026-07-02T00:30:00.000Z', {
        observationId: 'ineligible-start',
        eligible: false,
        selected: false,
        hardRejectionReasons: ['safety_source_failed']
      }),
      observation('2026-07-02T01:31:00.000Z', {
        observationId: 'requalified',
        eligible: true,
        selected: true
      })
    ]);

    expect(episodes).toHaveLength(2);
    expect(episodes[1]).toMatchObject({
      capturedAt: '2026-07-02T01:31:00.000Z',
      eligible: true,
      selected: true
    });
    expect(episodes[1]?.episodeId).not.toBe(episodes[0]?.episodeId);
  });

  it('does not infer an ineligible gap from missing observations', () => {
    const episodes = buildNonOverlappingOpportunityEpisodes([
      observation('2026-07-01T00:00:00.000Z'),
      observation('2026-07-03T00:00:00.000Z', {
        observationId: 'eligible-after-silence',
        eligible: true,
        selected: true
      }),
      observation('2026-07-03T00:10:00.000Z', {
        observationId: 'short-ineligible-start',
        eligible: false,
        selected: false
      }),
      observation('2026-07-03T01:09:59.999Z', {
        observationId: 'too-soon-requalified',
        eligible: true,
        selected: true
      })
    ]);

    expect(episodes).toHaveLength(1);
  });

  it('keeps independent pool and mint identities separate and is deterministic', () => {
    const rows = [
      observation('2026-07-01T00:00:00.000Z'),
      observation('2026-07-01T00:00:00.000Z', {
        observationId: 'pool-2-observation',
        poolAddress: 'pool-2'
      })
    ];

    const first = buildNonOverlappingOpportunityEpisodes(rows);
    const second = buildNonOverlappingOpportunityEpisodes([...rows].reverse());

    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    expect(new Set(first.map((episode) => episode.episodeId)).size).toBe(2);
  });

  it('fails closed on contradictory observations for the same identity and timestamp', () => {
    expect(() => buildNonOverlappingOpportunityEpisodes([
      observation('2026-07-01T00:00:00.000Z'),
      observation('2026-07-01T00:00:00.000Z', {
        observationId: 'contradictory-observation',
        eligible: false,
        selected: false,
        hardRejectionReasons: ['safety_source_failed']
      })
    ])).toThrow(/conflicting opportunity observations/i);
  });
});
