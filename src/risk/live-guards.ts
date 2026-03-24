export type LiveGuardInput = {
  symbol: string;
  whitelist: string[];
  requestedPositionSol: number;
  maxLivePositionSol: number;
  killSwitchEngaged: boolean;
  requireWhitelist?: boolean;
  sessionPhase?: 'active' | 'flatten-only' | 'closed';
};

export type LiveGuardResult =
  | {
      allowed: true;
      reason: 'allowed';
    }
  | {
      allowed: false;
      reason:
        | 'kill-switch-engaged'
        | 'flatten-only'
        | 'token-not-whitelisted'
        | 'live-position-cap-exceeded';
    };

export function evaluateLiveGuards(input: LiveGuardInput): LiveGuardResult {
  if (input.killSwitchEngaged) {
    return {
      allowed: false,
      reason: 'kill-switch-engaged'
    };
  }

  if (input.sessionPhase === 'flatten-only' || input.sessionPhase === 'closed') {
    return {
      allowed: false,
      reason: 'flatten-only'
    };
  }

  if ((input.requireWhitelist ?? true) && !input.whitelist.includes(input.symbol)) {
    return {
      allowed: false,
      reason: 'token-not-whitelisted'
    };
  }

  if (input.requestedPositionSol > input.maxLivePositionSol) {
    return {
      allowed: false,
      reason: 'live-position-cap-exceeded'
    };
  }

  return {
    allowed: true,
    reason: 'allowed'
  };
}
