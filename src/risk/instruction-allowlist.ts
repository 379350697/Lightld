export type InstructionAllowlistConfig = {
  maxOutputSol: number;
};

type AllowlistedIntent = {
  outputSol: number;
  side?: string;
};

export type InstructionAllowlistResult =
  | { allowed: true; reason: 'intent-allowed' }
  | {
      allowed: false;
      reason: 'output-sol-exceeds-allowlist-limit';
      detail: string;
    };

export function validateIntentAllowlist(
  intent: AllowlistedIntent,
  config: InstructionAllowlistConfig
): InstructionAllowlistResult {
  if (intent.side === 'withdraw-lp' || intent.side === 'sell' || intent.side === 'claim-fee') {
    return {
      allowed: true,
      reason: 'intent-allowed'
    };
  }

  if (intent.outputSol > config.maxOutputSol) {
    return {
      allowed: false,
      reason: 'output-sol-exceeds-allowlist-limit',
      detail: `outputSol ${intent.outputSol} exceeds allowlist limit of ${config.maxOutputSol} SOL`
    };
  }

  return {
    allowed: true,
    reason: 'intent-allowed'
  };
}
