export type EntryEconomicEdgeInput = {
  positionSol?: number;
  expectedFeeSol?: number;
  feeTvlRatio24h?: number;
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

function normalizedRatio(value: number) {
  return value > 1 ? value / 100 : value;
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
  const expectedFeeSol = nonnegative(input.expectedFeeSol)
    ?? (feeRatio ? positionSol * normalizedRatio(feeRatio) : undefined);
  const requiredEdgeSol = fromBps(positionSol, nonnegative(input.safetyMarginBps) ?? policy.defaultSafetyMarginBps ?? 10);
  if (expectedFeeSol === undefined) {
    return { accepted: false, reason: 'entry-edge-missing-fee', expectedFeeSol: 0, totalCostSol: 0, netEdgeSol: 0, requiredEdgeSol };
  }

  const totalCostSol =
    fromBps(positionSol, nonnegative(input.adverseSelectionBps) ?? policy.defaultAdverseSelectionBps ?? 25)
    + fromBps(positionSol, nonnegative(input.impermanentLossBps) ?? policy.defaultImpermanentLossBps ?? 25)
    + fromBps(positionSol, nonnegative(input.roundTripCostBps) ?? 0)
    + (nonnegative(input.chainCostSol) ?? policy.defaultChainCostSol ?? 0.000005)
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
