import { createHash } from 'node:crypto';

import { stableStringify } from '../shared/canonical-json.ts';
import {
  ExecutableMarkV2Schema,
  ResearchHorizonV2Schema,
  type CapacityPointV2,
  type ExecutableMarkV2,
  type ResearchHorizonV2,
  type ResearchStrategyIdV2
} from './types.ts';

export const RESEARCH_HORIZON_POLICY_V2 = Object.freeze({
  '15m': Object.freeze({ offsetMs: 15 * 60 * 1000, toleranceMs: 2 * 60 * 1000 }),
  '1h': Object.freeze({ offsetMs: 60 * 60 * 1000, toleranceMs: 5 * 60 * 1000 }),
  '4h': Object.freeze({ offsetMs: 4 * 60 * 60 * 1000, toleranceMs: 15 * 60 * 1000 }),
  '24h': Object.freeze({ offsetMs: 24 * 60 * 60 * 1000, toleranceMs: 60 * 60 * 1000 })
} satisfies Record<ResearchHorizonV2, { offsetMs: number; toleranceMs: number }>);

export type HorizonObservationClassificationV2 = {
  targetAt: string;
  observedAt: string;
  offsetMs: number;
  toleranceMs: number;
  deltaMs: number;
  classification: 'within_tolerance' | 'missed';
};

export function classifyHorizonObservation(
  horizon: ResearchHorizonV2,
  episodeCapturedAt: string,
  observedAt: string
): HorizonObservationClassificationV2 {
  const parsedHorizon = ResearchHorizonV2Schema.parse(horizon);
  const capturedAtMs = parseDateTime(episodeCapturedAt, 'episodeCapturedAt');
  const observedAtMs = parseDateTime(observedAt, 'observedAt');
  const policy = RESEARCH_HORIZON_POLICY_V2[parsedHorizon];
  const targetAtMs = capturedAtMs + policy.offsetMs;
  const deltaMs = observedAtMs - targetAtMs;

  return {
    targetAt: new Date(targetAtMs).toISOString(),
    observedAt: new Date(observedAtMs).toISOString(),
    offsetMs: policy.offsetMs,
    toleranceMs: policy.toleranceMs,
    deltaMs,
    classification: Math.abs(deltaMs) <= policy.toleranceMs ? 'within_tolerance' : 'missed'
  };
}

export type BuildExecutableMarkV2Input = {
  episodeId: string;
  strategyId: ResearchStrategyIdV2;
  tokenMint: string;
  poolAddress: string;
  horizon: ResearchHorizonV2;
  episodeCapturedAt: string;
  observedAt: string;
  routeStatus: 'available' | 'no_route' | 'dead_pool' | 'rug' | 'unknown';
  executableValueSol?: number;
  buyRouteAvailable?: boolean;
  sellRouteAvailable?: boolean;
  quoteSlot?: number;
  quoteAgeMs?: number;
  roundTripImpactBps?: number;
  capacityCurve?: CapacityPointV2[];
};

export function buildExecutableMarkV2(input: BuildExecutableMarkV2Input): ExecutableMarkV2 {
  const timing = classifyHorizonObservation(input.horizon, input.episodeCapturedAt, input.observedAt);
  const markId = deterministicMarkId(input.episodeId, input.horizon);

  if (timing.classification === 'missed') {
    return ExecutableMarkV2Schema.parse({
      schemaVersion: 2,
      markId,
      episodeId: input.episodeId,
      strategyId: input.strategyId,
      tokenMint: input.tokenMint,
      poolAddress: input.poolAddress,
      horizon: input.horizon,
      targetAt: timing.targetAt,
      observedAt: timing.observedAt,
      timingDeltaMs: timing.deltaMs,
      toleranceMs: timing.toleranceMs,
      timingClassification: 'missed',
      markStatus: 'missed',
      routeStatus: input.routeStatus,
      executableValueSol: null,
      recoveryValueSol: null,
      adverseReason: null,
      buyRouteAvailable: false,
      sellRouteAvailable: false,
      quoteSlot: input.quoteSlot ?? null,
      quoteAgeMs: input.quoteAgeMs ?? null,
      roundTripImpactBps: null,
      capacityCurve: []
    });
  }

  if (input.routeStatus === 'no_route' || input.routeStatus === 'dead_pool' || input.routeStatus === 'rug') {
    return ExecutableMarkV2Schema.parse({
      schemaVersion: 2,
      markId,
      episodeId: input.episodeId,
      strategyId: input.strategyId,
      tokenMint: input.tokenMint,
      poolAddress: input.poolAddress,
      horizon: input.horizon,
      targetAt: timing.targetAt,
      observedAt: timing.observedAt,
      timingDeltaMs: timing.deltaMs,
      toleranceMs: timing.toleranceMs,
      timingClassification: 'within_tolerance',
      markStatus: 'adverse',
      routeStatus: input.routeStatus,
      executableValueSol: null,
      recoveryValueSol: 0,
      adverseReason: input.routeStatus,
      buyRouteAvailable: input.buyRouteAvailable ?? false,
      sellRouteAvailable: false,
      quoteSlot: input.quoteSlot ?? null,
      quoteAgeMs: input.quoteAgeMs ?? null,
      roundTripImpactBps: input.roundTripImpactBps ?? null,
      capacityCurve: []
    });
  }

  return ExecutableMarkV2Schema.parse({
    schemaVersion: 2,
    markId,
    episodeId: input.episodeId,
    strategyId: input.strategyId,
    tokenMint: input.tokenMint,
    poolAddress: input.poolAddress,
    horizon: input.horizon,
    targetAt: timing.targetAt,
    observedAt: timing.observedAt,
    timingDeltaMs: timing.deltaMs,
    toleranceMs: timing.toleranceMs,
    timingClassification: 'within_tolerance',
    markStatus: 'observed',
    routeStatus: input.routeStatus,
    executableValueSol: input.executableValueSol ?? null,
    recoveryValueSol: null,
    adverseReason: null,
    buyRouteAvailable: input.buyRouteAvailable ?? false,
    sellRouteAvailable: input.sellRouteAvailable ?? false,
    quoteSlot: input.quoteSlot ?? null,
    quoteAgeMs: input.quoteAgeMs ?? null,
    roundTripImpactBps: input.roundTripImpactBps ?? null,
    capacityCurve: input.capacityCurve ?? []
  });
}

function deterministicMarkId(episodeId: string, horizon: ResearchHorizonV2) {
  const digest = createHash('sha256')
    .update(stableStringify({ schemaVersion: 2, episodeId, horizon }))
    .digest('hex')
    .slice(0, 32);
  return `mark-v2-${digest}`;
}

function parseDateTime(value: string, field: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO-8601 date-time.`);
  }
  return parsed;
}
