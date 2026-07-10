export type EntryEconomicEdgeSnapshot = {
  requestedPositionSol?: number;
  expectedFeeSol?: number;
  feeTvlRatio24h?: number;
  adverseSelectionCostSol?: number;
  adverseSelectionBps?: number;
  impermanentLossCostSol?: number;
  impermanentLossBps?: number;
  roundTripCostSol?: number;
  roundTripCostBps?: number;
  roundtripImpactBps?: number;
  impactBps?: number;
  slippageBps?: number;
  chainCostSol?: number;
  chainCostBps?: number;
  capitalChargeSol?: number;
  capitalChargeBps?: number;
  safetyMarginSol?: number;
  safetyMarginBps?: number;
};

export type EntryEconomicEdgeConfig = {
  requirePositiveExpectedEdge?: boolean;
  defaultAdverseSelectionBps?: number;
  defaultImpermanentLossBps?: number;
  defaultChainCostSol?: number;
  defaultCapitalChargeBps?: number;
  defaultSafetyMarginBps?: number;
};

export type EntryEconomicEdgeDecision = {
  accepted: boolean;
  reason: 'entry-edge-disabled'
    | 'entry-edge-positive'
    | 'entry-edge-missing-position-size'
    | 'entry-edge-missing-expected-fee'
    | 'entry-edge-not-positive';
  expectedFeeSol: number;
  adverseSelectionCostSol: number;
  impermanentLossCostSol: number;
  roundTripCostSol: number;
  chainCostSol: number;
  capitalChargeSol: number;
  safetyMarginSol: number;
  netEdgeSol: number;
  requiredEdgeSol: number;
};

function finitePositive(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNonnegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function solFromBps(positionSol: number, bps?: number) {
  return typeof bps === 'number' && Number.isFinite(bps) && bps >= 0
    ? (positionSol * bps) / 10_000
    : undefined;
}

function normalizeRatio(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value > 1 ? value / 100 : value;
}

function expectedFeeSol(snapshot: EntryEconomicEdgeSnapshot, positionSol: number) {
  const explicit = finiteNonnegative(snapshot.expectedFeeSol);
  if (typeof explicit === 'number') return explicit;

  const ratio = finitePositive(snapshot.feeTvlRatio24h);
  if (typeof ratio !== 'number') return undefined;

  const normalized = normalizeRatio(ratio);
  return typeof normalized === 'number' ? positionSol * normalized : undefined;
}

function roundTripCostSol(snapshot: EntryEconomicEdgeSnapshot, positionSol: number) {
  const explicit = finiteNonnegative(snapshot.roundTripCostSol);
  if (typeof explicit === 'number') return explicit;

  const bps = finiteNonnegative(snapshot.roundTripCostBps)
    ?? finiteNonnegative(snapshot.roundtripImpactBps)
    ?? (typeof finiteNonnegative(snapshot.impactBps) === 'number'
      ? finiteNonnegative(snapshot.impactBps)! * 2
      : undefined)
    ?? (typeof finiteNonnegative(snapshot.slippageBps) === 'number'
      ? finiteNonnegative(snapshot.slippageBps)! * 2
      : undefined);

  return solFromBps(positionSol, bps) ?? 0;
}

function componentCostSol(input: {
  positionSol: number;
  explicitSol?: number;
  explicitBps?: number;
  defaultBps?: number;
}) {
  const explicitSol = finiteNonnegative(input.explicitSol);
  if (typeof explicitSol === 'number') return explicitSol;
  return solFromBps(input.positionSol, finiteNonnegative(input.explicitBps) ?? input.defaultBps) ?? 0;
}

export function evaluateEntryEconomicEdge(
  snapshot: EntryEconomicEdgeSnapshot,
  config: EntryEconomicEdgeConfig = {}
): EntryEconomicEdgeDecision {
  const disabled = config.requirePositiveExpectedEdge !== true;
  const positionSol = finitePositive(snapshot.requestedPositionSol);
  const empty = {
    expectedFeeSol: 0,
    adverseSelectionCostSol: 0,
    impermanentLossCostSol: 0,
    roundTripCostSol: 0,
    chainCostSol: 0,
    capitalChargeSol: 0,
    safetyMarginSol: 0,
    netEdgeSol: 0,
    requiredEdgeSol: 0
  };

  if (disabled) {
    return {
      accepted: true,
      reason: 'entry-edge-disabled',
      ...empty
    };
  }

  if (typeof positionSol !== 'number') {
    return {
      accepted: false,
      reason: 'entry-edge-missing-position-size',
      ...empty
    };
  }

  const expectedFee = expectedFeeSol(snapshot, positionSol);
  if (typeof expectedFee !== 'number') {
    return {
      accepted: false,
      reason: 'entry-edge-missing-expected-fee',
      ...empty,
      requiredEdgeSol: componentCostSol({
        positionSol,
        explicitSol: snapshot.safetyMarginSol,
        explicitBps: snapshot.safetyMarginBps,
        defaultBps: config.defaultSafetyMarginBps ?? 10
      })
    };
  }

  const adverseSelectionCostSol = componentCostSol({
    positionSol,
    explicitSol: snapshot.adverseSelectionCostSol,
    explicitBps: snapshot.adverseSelectionBps,
    defaultBps: config.defaultAdverseSelectionBps ?? 25
  });
  const impermanentLossCostSol = componentCostSol({
    positionSol,
    explicitSol: snapshot.impermanentLossCostSol,
    explicitBps: snapshot.impermanentLossBps,
    defaultBps: config.defaultImpermanentLossBps ?? 25
  });
  const chainCostSol = componentCostSol({
    positionSol,
    explicitSol: snapshot.chainCostSol,
    explicitBps: snapshot.chainCostBps
  }) || (config.defaultChainCostSol ?? 0.000005);
  const capitalChargeSol = componentCostSol({
    positionSol,
    explicitSol: snapshot.capitalChargeSol,
    explicitBps: snapshot.capitalChargeBps,
    defaultBps: config.defaultCapitalChargeBps ?? 5
  });
  const safetyMarginSol = componentCostSol({
    positionSol,
    explicitSol: snapshot.safetyMarginSol,
    explicitBps: snapshot.safetyMarginBps,
    defaultBps: config.defaultSafetyMarginBps ?? 10
  });
  const roundTrip = roundTripCostSol(snapshot, positionSol);
  const netEdgeSol = expectedFee
    - adverseSelectionCostSol
    - impermanentLossCostSol
    - roundTrip
    - chainCostSol
    - capitalChargeSol;

  const accepted = netEdgeSol > safetyMarginSol;

  return {
    accepted,
    reason: accepted ? 'entry-edge-positive' : 'entry-edge-not-positive',
    expectedFeeSol: expectedFee,
    adverseSelectionCostSol,
    impermanentLossCostSol,
    roundTripCostSol: roundTrip,
    chainCostSol,
    capitalChargeSol,
    safetyMarginSol,
    netEdgeSol,
    requiredEdgeSol: safetyMarginSol
  };
}
