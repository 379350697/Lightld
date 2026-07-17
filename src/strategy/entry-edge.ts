import { DEFAULT_ROUND_TRIP_CHAIN_COST_SOL } from '../config/economic-defaults.ts';

export type EntryEconomicEdgeInput = {
  positionSol?: number;
  expectedFeeSol?: number;
  feeTvlRatio24h?: number;
  feeHorizonHours?: number;
  adverseSelectionBps?: number;
  impermanentLossBps?: number;
  roundTripCostBps?: number;
  chainCostSol?: number;
  capitalChargeBps?: number;
  safetyMarginBps?: number;
};

export type EntryEconomicEdgePolicy = {
  enabled?: boolean;
  defaultAdverseSelectionBps?: number;
  defaultImpermanentLossBps?: number;
  defaultChainCostSol?: number;
  defaultCapitalChargeBps?: number;
  defaultSafetyMarginBps?: number;
};

export type EntryEconomicEdgeDecision = {
  accepted: boolean;
  reason: 'entry-edge-disabled' | 'entry-edge-missing-position' | 'entry-edge-missing-fee' | 'entry-edge-positive' | 'entry-edge-not-positive';
  expectedFeeSol: number;
  totalCostSol: number;
  netEdgeSol: number;
  requiredEdgeSol: number;
};

function positive(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonnegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function fromBps(positionSol: number, bps: number) {
  return positionSol * bps / 10_000;
}

export function evaluateEntryEconomicEdge(
  input: EntryEconomicEdgeInput,
  policy: EntryEconomicEdgePolicy = {}
): EntryEconomicEdgeDecision {
  if (policy.enabled !== true) {
    return { accepted: true, reason: 'entry-edge-disabled', expectedFeeSol: 0, totalCostSol: 0, netEdgeSol: 0, requiredEdgeSol: 0 };
  }

  const positionSol = positive(input.positionSol);
  if (!positionSol) {
    return { accepted: false, reason: 'entry-edge-missing-position', expectedFeeSol: 0, totalCostSol: 0, netEdgeSol: 0, requiredEdgeSol: 0 };
  }

  const feeRatio = positive(input.feeTvlRatio24h);
  const feeHorizonHours = positive(input.feeHorizonHours) ?? 24;
  const expectedFeeSol = nonnegative(input.expectedFeeSol)
    ?? (feeRatio ? positionSol * feeRatio * Math.min(24, feeHorizonHours) / 24 : undefined);
  const requiredEdgeSol = fromBps(positionSol, nonnegative(input.safetyMarginBps) ?? policy.defaultSafetyMarginBps ?? 10);
  if (expectedFeeSol === undefined) {
    return { accepted: false, reason: 'entry-edge-missing-fee', expectedFeeSol: 0, totalCostSol: 0, netEdgeSol: 0, requiredEdgeSol };
  }

  const totalCostSol =
    fromBps(positionSol, nonnegative(input.adverseSelectionBps) ?? policy.defaultAdverseSelectionBps ?? 25)
    + fromBps(positionSol, nonnegative(input.impermanentLossBps) ?? policy.defaultImpermanentLossBps ?? 25)
    + fromBps(positionSol, nonnegative(input.roundTripCostBps) ?? 0)
    + (nonnegative(input.chainCostSol) ?? policy.defaultChainCostSol ?? DEFAULT_ROUND_TRIP_CHAIN_COST_SOL)
    + fromBps(positionSol, nonnegative(input.capitalChargeBps) ?? policy.defaultCapitalChargeBps ?? 5);
  const netEdgeSol = expectedFeeSol - totalCostSol;
  const accepted = netEdgeSol > requiredEdgeSol;

  return {
    accepted,
    reason: accepted ? 'entry-edge-positive' : 'entry-edge-not-positive',
    expectedFeeSol,
    totalCostSol,
    netEdgeSol,
    requiredEdgeSol
  };
}
