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

export function classifyAction(action: LiveAction): LiveActionClass {
  switch (action) {
    case 'deploy':
    case 'add-lp':
      return 'open_risk';
    case 'dca-out':
    case 'withdraw-lp':
      return 'reduce_risk';
    case 'claim-fee':
    case 'rebalance-lp':
      return 'maintain_position';
    case 'hold':
      return 'no_op';
  }
}

export function isExposureIncreasingAction(action: LiveAction) {
  return classifyAction(action) === 'open_risk';
}

export function isExposureReducingAction(action: LiveAction) {
  return classifyAction(action) === 'reduce_risk';
}
