import { createHash } from 'node:crypto';

import type { StrategyConfig } from '../config/schema.ts';
import type { IngestCandidate } from '../runtime/ingest-candidate-selection.ts';
import { filterLpEligibleCandidates, rankCandidatesForSafety, selectCandidate } from '../runtime/ingest-candidate-selection.ts';
import { evaluateEntryEconomicEdge } from '../strategy/entry-edge.ts';
import { evaluateHardGates } from '../strategy/filtering/hard-gates.ts';
import { applyStrategyPatch } from './spec.ts';
import { StrategyResearchStore } from './store.ts';
import type { CaptureResearchSnapshotInput, StrategyResearchSpec } from './types.ts';

export type CandidateResearchRecorder = {
  capture(input: {
    strategyId: 'new-token-v1' | 'large-pool-v1';
    observedAt: string;
    captureMode: string;
    baseConfig: StrategyConfig;
    candidates: IngestCandidate[];
  }): Promise<void>;
};

export class SqliteCandidateResearchRecorder implements CandidateResearchRecorder {
  private readonly store: StrategyResearchStore;
  private readonly captureIntervalMs: number;

  constructor(
    store: StrategyResearchStore,
    captureIntervalMs = 15 * 60_000
  ) {
    this.store = store;
    this.captureIntervalMs = captureIntervalMs;
  }

  async capture(input: {
    strategyId: 'new-token-v1' | 'large-pool-v1';
    observedAt: string;
    captureMode: string;
    baseConfig: StrategyConfig;
    candidates: IngestCandidate[];
  }) {
    if (input.captureMode !== 'mechanical-soak' && input.captureMode !== 'economic-shadow') return;
    const spec = this.store.activeExperiment();
    if (!spec || spec.strategyId !== input.strategyId) return;
    if (this.store.hasRecentSnapshot(spec.experimentId, input.observedAt, this.captureIntervalMs)) return;
    const candidates = rankCandidatesForSafety(input.candidates).slice(0, 20);
    if (candidates.length === 0) return;
    this.store.captureSnapshot(buildSnapshot(spec, input.baseConfig, candidates, input.observedAt, input.captureMode));
  }
}

export function buildSnapshot(
  spec: StrategyResearchSpec,
  baseConfig: StrategyConfig,
  candidates: IngestCandidate[],
  observedAt: string,
  captureMode: 'mechanical-soak' | 'economic-shadow'
): CaptureResearchSnapshotInput {
  const lockedBaseConfig = spec.baseConfig ?? baseConfig;
  const identities = candidates.map((candidate) => `${candidate.address}:${candidate.mint}`).sort();
  const snapshotId = `snapshot-${createHash('sha256')
    .update(JSON.stringify({ experimentId: spec.experimentId, observedAt, identities }))
    .digest('hex').slice(0, 32)}`;
  const variants = [
    { variantId: 'baseline', config: lockedBaseConfig },
    ...spec.variants.map((variant) => ({
      variantId: variant.variantId,
      config: applyStrategyPatch(lockedBaseConfig, variant.parameterPatch)
    }))
  ];
  const decisions = variants.flatMap(({ variantId, config }) => {
    const positionSol = Math.min(spec.positionSol, config.riskThresholds.maxPositionSol);
    const eligible = filterLpEligibleCandidates(candidates, config).filter((candidate) =>
      isEntryEligible(candidate, config, positionSol)
    );
    const eligibleKeys = new Set(eligible.map(candidateKey));
    const selected = selectCandidate(eligible, spec.strategyId, 0);
    const selectedKey = selected ? candidateKey(selected) : '';
    return candidates.map((candidate) => ({
      variantId,
      poolAddress: candidate.address,
      tokenMint: candidate.mint,
      selected: candidateKey(candidate) === selectedKey,
      eligible: eligibleKeys.has(candidateKey(candidate)),
      reason: candidateKey(candidate) === selectedKey
        ? 'selected'
        : eligibleKeys.has(candidateKey(candidate)) ? 'lower-rank' : 'strategy-filter',
      positionSol
    }));
  });

  return {
    snapshotId,
    experimentId: spec.experimentId,
    strategyId: spec.strategyId,
    observedAt,
    captureMode,
    candidates: candidates.map((candidate) => ({
      poolAddress: candidate.address,
      tokenMint: candidate.mint,
      tokenSymbol: candidate.symbol,
      features: {
        liquidityUsd: candidate.liquidityUsd,
        volume24h: candidate.volume24h,
        feeTvlRatio24h: candidate.feeTvlRatio24h,
        binStep: candidate.binStep,
        baseFeePct: candidate.baseFeePct,
        safetyScore: candidate.safetyScore ?? 0,
        poolFeeYieldScore: candidate.poolFeeYieldScore ?? 0,
        netFeeYield1h: candidate.netFeeYield1h ?? 0,
        hasInventory: candidate.hasInventory,
        hasLpPosition: candidate.hasLpPosition
      }
    })),
    decisions
  };
}

function isEntryEligible(candidate: IngestCandidate, config: StrategyConfig, positionSol: number) {
  const gates = evaluateHardGates({
    hasSolRoute: candidate.hasSolRoute,
    liquidityUsd: candidate.liquidityUsd,
    poolCreatedAt: candidate.capturedAt
  }, config.hardGates);
  if (!gates.accepted) return false;
  return evaluateEntryEconomicEdge({
    positionSol,
    feeTvlRatio24h: candidate.feeTvlRatio24h
  }, config.entryEdge).accepted;
}

function candidateKey(candidate: IngestCandidate) {
  return `${candidate.address}\0${candidate.mint}`;
}
