export type LpSolExposureStatus = 'sol-heavy' | 'mixed' | 'token-heavy' | 'sol-depleted';

export const DEFAULT_SOL_DEPLETION_EXIT_BINS = 60;

export function computeSolDepletedBins(input: {
  lowerBinId?: number;
  upperBinId?: number;
  activeBinId?: number;
  solSide?: 'tokenX' | 'tokenY';
}) {
  if (
    typeof input.lowerBinId !== 'number' ||
    typeof input.upperBinId !== 'number' ||
    typeof input.activeBinId !== 'number' ||
    (input.solSide !== 'tokenX' && input.solSide !== 'tokenY')
  ) {
    return undefined;
  }

  if (input.solSide === 'tokenX') {
    return Math.max(0, input.activeBinId - input.lowerBinId);
  }

  return Math.max(0, input.upperBinId - input.activeBinId);
}

export function deriveLpSolExposureStatus(input: {
  solDepletedBins?: number;
  binCount?: number;
  solDepletionExitBins?: number;
  withdrawSolAmount?: number;
  withdrawTokenValueSol?: number;
}): LpSolExposureStatus | undefined {
  if (
    typeof input.solDepletionExitBins === 'number' &&
    typeof input.solDepletedBins === 'number' &&
    input.solDepletedBins >= input.solDepletionExitBins
  ) {
    return 'sol-depleted';
  }

  if (
    typeof input.withdrawSolAmount === 'number' &&
    typeof input.withdrawTokenValueSol === 'number' &&
    Number.isFinite(input.withdrawSolAmount) &&
    Number.isFinite(input.withdrawTokenValueSol) &&
    input.withdrawSolAmount >= 0 &&
    input.withdrawTokenValueSol >= 0
  ) {
    const totalValueSol = input.withdrawSolAmount + input.withdrawTokenValueSol;
    if (totalValueSol > 0) {
      const solRatio = input.withdrawSolAmount / totalValueSol;
      if (solRatio <= 0.05) {
        return 'sol-depleted';
      }
      if (solRatio <= 0.25) {
        return 'token-heavy';
      }
      if (solRatio <= 0.75) {
        return 'mixed';
      }
      return 'sol-heavy';
    }
  }

  if (
    typeof input.solDepletedBins === 'number' &&
    typeof input.binCount === 'number' &&
    input.binCount > 0
  ) {
    const depletedRatio = input.solDepletedBins / input.binCount;
    if (depletedRatio >= 0.85) {
      return 'token-heavy';
    }
    if (depletedRatio >= 0.35) {
      return 'mixed';
    }
    return 'sol-heavy';
  }

  return undefined;
}
