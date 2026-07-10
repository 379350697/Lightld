import { describe, expect, it } from 'vitest';

import {
  ExecutableMarkV2Schema,
  buildExecutableMarkV2,
  classifyHorizonObservation,
  type ResearchHorizonV2
} from '../../../src/research-v2';

describe('classifyHorizonObservation', () => {
  it.each([
    ['15m', '2026-07-01T00:17:00.000Z', 'within_tolerance'],
    ['15m', '2026-07-01T00:17:00.001Z', 'missed'],
    ['1h', '2026-07-01T01:05:00.000Z', 'within_tolerance'],
    ['1h', '2026-07-01T01:05:00.001Z', 'missed'],
    ['4h', '2026-07-01T04:15:00.000Z', 'within_tolerance'],
    ['4h', '2026-07-01T04:15:00.001Z', 'missed'],
    ['24h', '2026-07-02T01:00:00.000Z', 'within_tolerance'],
    ['24h', '2026-07-02T01:00:00.001Z', 'missed']
  ])('classifies %s using its fixed tolerance', (horizon, observedAt, expected) => {
    expect(classifyHorizonObservation(
      horizon as ResearchHorizonV2,
      '2026-07-01T00:00:00.000Z',
      observedAt
    ).classification).toBe(expected);
  });
});

describe('buildExecutableMarkV2', () => {
  it('records a no-route observation as a conservative zero-recovery adverse outcome', () => {
    const mark = buildExecutableMarkV2({
      episodeId: 'episode-1',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-1',
      poolAddress: 'pool-1',
      horizon: '1h',
      episodeCapturedAt: '2026-07-01T00:00:00.000Z',
      observedAt: '2026-07-01T01:02:00.000Z',
      routeStatus: 'no_route',
      quoteSlot: 123,
      quoteAgeMs: 200
    });

    expect(mark).toMatchObject({
      schemaVersion: 2,
      markStatus: 'adverse',
      timingClassification: 'within_tolerance',
      routeStatus: 'no_route',
      recoveryValueSol: 0,
      adverseReason: 'no_route'
    });
    expect(() => ExecutableMarkV2Schema.parse({
      ...mark,
      recoveryValueSol: 0.01
    })).toThrow();
  });

  it('marks an out-of-tolerance observation missed even when a quote was returned', () => {
    const mark = buildExecutableMarkV2({
      episodeId: 'episode-1',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-1',
      poolAddress: 'pool-1',
      horizon: '4h',
      episodeCapturedAt: '2026-07-01T00:00:00.000Z',
      observedAt: '2026-07-01T05:00:00.000Z',
      routeStatus: 'available',
      executableValueSol: 0.2,
      quoteSlot: 124,
      quoteAgeMs: 100,
      roundTripImpactBps: 90,
      capacityCurve: [{ inputSol: 0.01, outputSol: 0.0098, impactBps: 20 }]
    });

    expect(mark).toMatchObject({
      markStatus: 'missed',
      timingClassification: 'missed',
      executableValueSol: null,
      capacityCurve: []
    });
  });

  it('preserves executable two-sided quote evidence when observed within tolerance', () => {
    const mark = buildExecutableMarkV2({
      episodeId: 'episode-1',
      strategyId: 'new-token-v1',
      tokenMint: 'mint-1',
      poolAddress: 'pool-1',
      horizon: '24h',
      episodeCapturedAt: '2026-07-01T00:00:00.000Z',
      observedAt: '2026-07-02T00:30:00.000Z',
      routeStatus: 'available',
      executableValueSol: 0.21,
      buyRouteAvailable: true,
      sellRouteAvailable: true,
      quoteSlot: 999,
      quoteAgeMs: 250,
      roundTripImpactBps: 75,
      capacityCurve: [{ inputSol: 0.1, outputSol: 0.098, impactBps: 75 }]
    });

    expect(mark).toMatchObject({
      markStatus: 'observed',
      routeStatus: 'available',
      executableValueSol: 0.21,
      buyRouteAvailable: true,
      sellRouteAvailable: true
    });
    expect(() => ExecutableMarkV2Schema.parse({
      ...mark,
      toleranceMs: mark.toleranceMs + 1
    })).toThrow(/fixed research horizon policy/i);
    expect(() => ExecutableMarkV2Schema.parse({
      ...mark,
      capacityCurve: []
    })).toThrow(/two-sided route evidence/i);
  });
});
