import type { LpValuationStatus } from './lp-position-record.ts';

export function evaluateLpValuationState(input: {
  currentValueSol?: number;
  unclaimedFeeSol?: number;
  hasClaimableFees?: boolean;
  observedAt: string;
}): {
  valuationStatus: LpValuationStatus;
  valuationReason: string;
  lastValuationAt: string;
} {
  if (typeof input.currentValueSol !== 'number' || !Number.isFinite(input.currentValueSol) || input.currentValueSol < 0) {
    return {
      valuationStatus: 'unavailable',
      valuationReason: 'missing-current-value',
      lastValuationAt: input.observedAt
    };
  }

  if (typeof input.unclaimedFeeSol === 'number' && (!Number.isFinite(input.unclaimedFeeSol) || input.unclaimedFeeSol < 0)) {
    return {
      valuationStatus: 'invalid',
      valuationReason: 'invalid-unclaimed-fee',
      lastValuationAt: input.observedAt
    };
  }

  if (typeof input.unclaimedFeeSol !== 'number' && input.hasClaimableFees) {
    return {
      valuationStatus: 'unavailable',
      valuationReason: 'missing-unclaimed-fee',
      lastValuationAt: input.observedAt
    };
  }

  return {
    valuationStatus: 'ready',
    valuationReason: '',
    lastValuationAt: input.observedAt
  };
}
