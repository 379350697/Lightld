export type LiveGuardInput = {
  symbol: string;
  whitelist: string[];
  requestedPositionSol: number;
  maxLivePositionSol: number;
  killSwitchEngaged: boolean;
  requireWhitelist?: boolean;
  sessionPhase?: 'active' | 'flatten-only' | 'closed';
  maxSingleOrderSol?: number;
  maxDailySpendSol?: number;
  dailySpendSol?: number;
  
  // Rug protection checks
  mintAuthorityRevoked?: boolean;
  requireMintAuthorityRevoked?: boolean;
  lpBurnedPct?: number;
  requireLpBurnedPct?: number;
  top10HoldersPct?: number;
  maxTop10HoldersPct?: number;
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
        | 'live-position-cap-exceeded'
        | 'single-order-limit-exceeded'
        | 'daily-spend-limit-exceeded'
        | 'mint-authority-not-revoked'
        | 'lp-burn-insufficient'
        | 'top-holders-concentrated';
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

  if (
    typeof input.maxSingleOrderSol === 'number' &&
    input.requestedPositionSol > input.maxSingleOrderSol
  ) {
    return {
      allowed: false,
      reason: 'single-order-limit-exceeded'
    };
  }

  if (
    typeof input.maxDailySpendSol === 'number' &&
    typeof input.dailySpendSol === 'number' &&
    input.dailySpendSol + input.requestedPositionSol > input.maxDailySpendSol
  ) {
    return {
      allowed: false,
      reason: 'daily-spend-limit-exceeded'
    };
  }

  if (input.requireMintAuthorityRevoked && input.mintAuthorityRevoked === false) {
    return {
      allowed: false,
      reason: 'mint-authority-not-revoked'
    };
  }

  if (
    typeof input.requireLpBurnedPct === 'number' &&
    typeof input.lpBurnedPct === 'number' &&
    input.lpBurnedPct < input.requireLpBurnedPct
  ) {
    return {
      allowed: false,
      reason: 'lp-burn-insufficient'
    };
  }

  if (
    typeof input.maxTop10HoldersPct === 'number' &&
    typeof input.top10HoldersPct === 'number' &&
    input.top10HoldersPct > input.maxTop10HoldersPct
  ) {
    return {
      allowed: false,
      reason: 'top-holders-concentrated'
    };
  }

  return {
    allowed: true,
    reason: 'allowed'
  };
}
