export type InstructionAllowlistConfig = {
  maxOutputSol: number;
};

export type InstructionAllowlistResult =
  | { allowed: true; reason: 'intent-allowed' }
  | {
      allowed: false;
      reason: 'output-sol-exceeds-allowlist-limit';
      detail: string;
    };

export function validateIntentAllowlist(
  intent: { outputSol: number },
  config: InstructionAllowlistConfig
): InstructionAllowlistResult {
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
