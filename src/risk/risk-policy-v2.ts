import { createHash } from 'node:crypto';

import { z } from 'zod';

import { stableStringify } from '../shared/canonical-json.ts';
import { RiskStateV2Schema, type RiskStateV2 } from './risk-state-v2.ts';

export const RiskLimitsV2Schema = z.object({
  maxPositionSol: z.number().finite().positive(),
  maxActivePositions: z.number().int().positive(),
  maxDailyNewRiskSol: z.number().finite().positive(),
  maxDailyLossSol: z.number().finite().positive(),
  maxDrawdownPct: z.number().finite().positive().max(100),
  warningFraction: z.number().finite().positive().max(1),
  minimumSolReserveSol: z.number().finite().nonnegative(),
  stressCloseCostSol: z.number().finite().nonnegative().optional(),
  rentReserveSol: z.number().finite().nonnegative().optional(),
  autoFlattenRequired: z.boolean()
});

export type RiskLimitsV2 = z.infer<typeof RiskLimitsV2Schema>;

export const CANARY_RISK_LIMITS: Readonly<RiskLimitsV2> = Object.freeze(RiskLimitsV2Schema.parse({
  maxPositionSol: 0.01,
  maxActivePositions: 1,
  maxDailyNewRiskSol: 0.05,
  maxDailyLossSol: 0.02,
  maxDrawdownPct: 1,
  warningFraction: 0.8,
  minimumSolReserveSol: 0.05,
  autoFlattenRequired: true
}));

export type InitialRiskStateV2Input = {
  now: string;
  startOfDayEquitySol: number;
  currentEquitySol: number;
  availableSol: number;
};

export type RiskObservationV2 = {
  now: string;
  currentEquitySol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  availableSol: number;
  grossExposureSol?: number;
  netExposureSol?: number;
  exposureByMintSol?: Record<string, number>;
  exposureByPoolSol?: Record<string, number>;
  exposureByDeployerSol?: Record<string, number>;
  consecutiveLosses?: number;
  activePositionCount?: number;
  dailyNewRiskSol?: number;
  dataQualityStatus?: RiskStateV2['dataQualityStatus'];
  reconciliationStatus?: RiskStateV2['reconciliationStatus'];
  outboxStatus?: RiskStateV2['outboxStatus'];
  valuationStatus?: RiskStateV2['valuationStatus'];
};

function withSnapshotId(state: Omit<RiskStateV2, 'riskSnapshotId'>): RiskStateV2 {
  const riskSnapshotId = createHash('sha256')
    .update(stableStringify(state))
    .digest('hex');

  return RiskStateV2Schema.parse({
    ...state,
    riskSnapshotId
  });
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

function approximatelyAtLeast(value: number, limit: number) {
  return value > limit || Math.abs(value - limit) <= 1e-12;
}

export function resolveMinimumSolReserve(limits: RiskLimitsV2) {
  return Math.max(
    limits.minimumSolReserveSol,
    3 * (limits.stressCloseCostSol ?? 0) + (limits.rentReserveSol ?? 0)
  );
}

function currentBlockingReasons(state: RiskStateV2, limits: RiskLimitsV2) {
  const reasons: string[] = [];
  const dailyLossSol = Math.max(0, -state.dailyNetPnlSol);

  if (state.dataQualityStatus !== 'trusted') {
    reasons.push('data-quality-untrusted');
  }
  if (state.reconciliationStatus !== 'matched') {
    reasons.push('reconciliation-untrusted');
  }
  if (state.outboxStatus !== 'settled') {
    reasons.push('outbox-untrusted');
  }
  if (state.valuationStatus !== 'ready') {
    reasons.push('valuation-untrusted');
  }
  if (approximatelyAtLeast(dailyLossSol, limits.maxDailyLossSol)) {
    reasons.push('daily-loss-limit');
  } else if (approximatelyAtLeast(dailyLossSol, limits.maxDailyLossSol * limits.warningFraction)) {
    reasons.push('daily-loss-warning');
  }
  if (approximatelyAtLeast(state.drawdownPct, limits.maxDrawdownPct)) {
    reasons.push('drawdown-limit');
  } else if (approximatelyAtLeast(state.drawdownPct, limits.maxDrawdownPct * limits.warningFraction)) {
    reasons.push('drawdown-warning');
  }
  if (state.availableSol < resolveMinimumSolReserve(limits)) {
    reasons.push('sol-reserve-limit');
  }

  return reasons;
}

export function createInitialRiskStateV2(input: InitialRiskStateV2Input): RiskStateV2 {
  const highWaterEquitySol = Math.max(input.startOfDayEquitySol, input.currentEquitySol);
  const drawdownPct = highWaterEquitySol > 0
    ? Math.max(0, ((highWaterEquitySol - input.currentEquitySol) / highWaterEquitySol) * 100)
    : 0;

  return withSnapshotId({
    schemaVersion: 2,
    asOf: input.now,
    tradingDate: input.now.slice(0, 10),
    riskMode: 'healthy',
    startOfDayEquitySol: input.startOfDayEquitySol,
    currentEquitySol: input.currentEquitySol,
    highWaterEquitySol,
    realizedPnlSol: 0,
    unrealizedPnlSol: 0,
    dailyNetPnlSol: 0,
    drawdownPct,
    grossExposureSol: 0,
    netExposureSol: 0,
    exposureByMintSol: {},
    exposureByPoolSol: {},
    exposureByDeployerSol: {},
    consecutiveLosses: 0,
    activePositionCount: 0,
    dailyNewRiskSol: 0,
    availableSol: input.availableSol,
    dataQualityStatus: 'trusted',
    reconciliationStatus: 'matched',
    outboxStatus: 'settled',
    valuationStatus: 'ready',
    allowNewOpens: true,
    allowRiskIncrease: true,
    allowRiskReduction: true,
    flattenOnly: false,
    autoFlattenRequired: false,
    manualRecoveryRequired: false,
    triggerReasons: []
  });
}

export function applyRiskObservation(
  previous: RiskStateV2,
  observation: RiskObservationV2,
  limits: RiskLimitsV2
): RiskStateV2 {
  const highWaterEquitySol = Math.max(previous.highWaterEquitySol, observation.currentEquitySol);
  const dailyNetPnlSol = observation.realizedPnlSol + observation.unrealizedPnlSol;
  const drawdownPct = highWaterEquitySol > 0
    ? Math.max(0, ((highWaterEquitySol - observation.currentEquitySol) / highWaterEquitySol) * 100)
    : 0;
  const observed: Omit<RiskStateV2, 'riskSnapshotId'> = {
    ...previous,
    schemaVersion: 2,
    asOf: observation.now,
    currentEquitySol: observation.currentEquitySol,
    highWaterEquitySol,
    realizedPnlSol: observation.realizedPnlSol,
    unrealizedPnlSol: observation.unrealizedPnlSol,
    dailyNetPnlSol,
    drawdownPct,
    availableSol: observation.availableSol,
    grossExposureSol: observation.grossExposureSol ?? previous.grossExposureSol,
    netExposureSol: observation.netExposureSol ?? previous.netExposureSol,
    exposureByMintSol: observation.exposureByMintSol ?? previous.exposureByMintSol,
    exposureByPoolSol: observation.exposureByPoolSol ?? previous.exposureByPoolSol,
    exposureByDeployerSol: observation.exposureByDeployerSol ?? previous.exposureByDeployerSol,
    consecutiveLosses: observation.consecutiveLosses ?? previous.consecutiveLosses,
    activePositionCount: observation.activePositionCount ?? previous.activePositionCount,
    dailyNewRiskSol: observation.dailyNewRiskSol ?? previous.dailyNewRiskSol,
    dataQualityStatus: observation.dataQualityStatus ?? previous.dataQualityStatus,
    reconciliationStatus: observation.reconciliationStatus ?? previous.reconciliationStatus,
    outboxStatus: observation.outboxStatus ?? previous.outboxStatus,
    valuationStatus: observation.valuationStatus ?? previous.valuationStatus
  };
  const dailyLossSol = Math.max(0, -dailyNetPnlSol);
  const dataReasons = [
    observed.dataQualityStatus !== 'trusted' ? 'data-quality-untrusted' : undefined,
    observed.reconciliationStatus !== 'matched' ? 'reconciliation-untrusted' : undefined,
    observed.outboxStatus !== 'settled' ? 'outbox-untrusted' : undefined,
    observed.valuationStatus !== 'ready' ? 'valuation-untrusted' : undefined
  ].filter((reason): reason is string => !!reason);
  const hardReasons = [
    approximatelyAtLeast(dailyLossSol, limits.maxDailyLossSol) ? 'daily-loss-limit' : undefined,
    approximatelyAtLeast(drawdownPct, limits.maxDrawdownPct) ? 'drawdown-limit' : undefined
  ].filter((reason): reason is string => !!reason);
  const warningReasons = [
    approximatelyAtLeast(dailyLossSol, limits.maxDailyLossSol * limits.warningFraction)
      ? 'daily-loss-warning'
      : undefined,
    approximatelyAtLeast(drawdownPct, limits.maxDrawdownPct * limits.warningFraction)
      ? 'drawdown-warning'
      : undefined,
    observed.availableSol < resolveMinimumSolReserve(limits) ? 'sol-reserve-warning' : undefined
  ].filter((reason): reason is string => !!reason);

  let riskMode: RiskStateV2['riskMode'] = 'healthy';
  let flattenOnly = false;
  let autoFlattenRequired = false;
  let triggerReasons: string[] = [];

  if (dataReasons.length > 0) {
    riskMode = 'reconcile_required';
    triggerReasons = dataReasons;
  } else if (hardReasons.length > 0) {
    riskMode = 'flatten_only';
    flattenOnly = true;
    autoFlattenRequired = limits.autoFlattenRequired;
    triggerReasons = hardReasons;
  } else if (warningReasons.length > 0) {
    riskMode = 'warning';
    triggerReasons = warningReasons;
  } else if (previous.manualRecoveryRequired) {
    riskMode = 'manual_hold';
    triggerReasons = previous.triggerReasons;
  }

  const blocked = riskMode !== 'healthy';

  return withSnapshotId({
    ...observed,
    riskMode,
    allowNewOpens: !blocked,
    allowRiskIncrease: !blocked,
    allowRiskReduction: true,
    flattenOnly,
    autoFlattenRequired,
    manualRecoveryRequired: blocked || previous.manualRecoveryRequired,
    triggerReasons: unique(triggerReasons),
    recoveryApprovedBy: undefined,
    recoveryApprovedAt: undefined
  });
}

export type RiskRecoveryApproval = {
  approvedBy: string;
  approvedAt: string;
};

export function approveRiskRecovery(
  state: RiskStateV2,
  approval: RiskRecoveryApproval,
  limits: RiskLimitsV2
): RiskStateV2 {
  const unsafeReasons = currentBlockingReasons(state, limits);

  if (unsafeReasons.length > 0) {
    throw new Error(`Risk recovery is unsafe: ${unsafeReasons.join(', ')}`);
  }

  if (!approval.approvedBy.trim()) {
    throw new Error('Risk recovery requires an operator identity');
  }

  return withSnapshotId({
    ...state,
    asOf: approval.approvedAt,
    riskMode: 'healthy',
    allowNewOpens: true,
    allowRiskIncrease: true,
    allowRiskReduction: true,
    flattenOnly: false,
    autoFlattenRequired: false,
    manualRecoveryRequired: false,
    triggerReasons: [],
    recoveryApprovedBy: approval.approvedBy,
    recoveryApprovedAt: approval.approvedAt
  });
}

export type RiskIncreaseRequest = {
  amountSol: number;
};

export type RiskIncreaseDecision =
  | { allowed: true; reason: 'risk-increase-allowed' }
  | {
      allowed: false;
      reason:
        | 'risk-state-blocked'
        | 'position-limit-exceeded'
        | 'active-position-limit-exceeded'
        | 'daily-new-risk-limit-exceeded'
        | 'insufficient-sol-reserve';
      detail: string;
    };

export function evaluateRiskIncrease(
  state: RiskStateV2,
  request: RiskIncreaseRequest,
  limits: RiskLimitsV2
): RiskIncreaseDecision {
  if (!Number.isFinite(request.amountSol) || request.amountSol <= 0) {
    return {
      allowed: false,
      reason: 'position-limit-exceeded',
      detail: 'amountSol must be finite and positive'
    };
  }

  if (!state.allowRiskIncrease || state.riskMode !== 'healthy') {
    return {
      allowed: false,
      reason: 'risk-state-blocked',
      detail: `risk mode ${state.riskMode} does not allow risk increases`
    };
  }

  if (request.amountSol > limits.maxPositionSol) {
    return {
      allowed: false,
      reason: 'position-limit-exceeded',
      detail: `${request.amountSol} SOL exceeds max position ${limits.maxPositionSol} SOL`
    };
  }

  if (state.activePositionCount >= limits.maxActivePositions) {
    return {
      allowed: false,
      reason: 'active-position-limit-exceeded',
      detail: `active positions ${state.activePositionCount} reached limit ${limits.maxActivePositions}`
    };
  }

  if (state.dailyNewRiskSol + request.amountSol > limits.maxDailyNewRiskSol) {
    return {
      allowed: false,
      reason: 'daily-new-risk-limit-exceeded',
      detail: `daily new risk would exceed ${limits.maxDailyNewRiskSol} SOL`
    };
  }

  const reserve = resolveMinimumSolReserve(limits);
  if (state.availableSol - request.amountSol < reserve) {
    return {
      allowed: false,
      reason: 'insufficient-sol-reserve',
      detail: `available SOL after order would fall below reserve ${reserve} SOL`
    };
  }

  return {
    allowed: true,
    reason: 'risk-increase-allowed'
  };
}
