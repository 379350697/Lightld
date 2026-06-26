export const LIVE_ACTIONS = [
  'hold',
  'deploy',
  'dca-out',
  'add-lp',
  'withdraw-lp',
  'claim-fee',
  'rebalance-lp'
] as const;

export type LiveAction = typeof LIVE_ACTIONS[number];
export type LiveActionClass = 'open_risk' | 'reduce_risk' | 'maintain_position' | 'no_op';

export function isOpenRiskAction(action: LiveAction) {
  return action === 'deploy' || action === 'add-lp';
}

export function isFullExitAction(action: LiveAction) {
  return action === 'dca-out' || action === 'withdraw-lp';
}

export function isRiskReducingAction(action: LiveAction) {
  return isFullExitAction(action);
}

export function isLpMaintenanceAction(action: LiveAction) {
  return action === 'claim-fee' || action === 'rebalance-lp';
}

export function classifyAction(action: LiveAction): LiveActionClass {
  if (isOpenRiskAction(action)) {
    return 'open_risk';
  }

  if (isRiskReducingAction(action)) {
    return 'reduce_risk';
  }

  if (isLpMaintenanceAction(action)) {
    return 'maintain_position';
  }

  return 'no_op';
}

export function isExposureIncreasingAction(action: LiveAction) {
  return isOpenRiskAction(action);
}

export function isExposureReducingAction(action: LiveAction) {
  return isRiskReducingAction(action);
}
