export type RuntimeLpPositionStatus = 'active' | 'residual' | 'empty';

type LpVisibilityInput = {
  hasLiquidity?: boolean;
  hasClaimableFees?: boolean;
  currentValueSol?: number;
  positionStatus?: RuntimeLpPositionStatus;
};

export function isManageableLpPosition(position: LpVisibilityInput) {
  if (position.positionStatus === 'empty') {
    return false;
  }

  if (position.positionStatus === 'residual') {
    return true;
  }

  if (position.hasLiquidity ?? true) {
    return true;
  }

  if (position.hasClaimableFees ?? false) {
    return true;
  }

  return typeof position.currentValueSol === 'number' && position.currentValueSol > 0;
}
