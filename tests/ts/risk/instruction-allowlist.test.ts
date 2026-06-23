import { describe, expect, it } from 'vitest';

import { validateIntentAllowlist } from '../../../src/risk/instruction-allowlist';

describe('validateIntentAllowlist', () => {
  it('allows an intent within the output limit', () => {
    const result = validateIntentAllowlist(
      { outputSol: 0.1 },
      { maxOutputSol: 0.5 }
    );

    expect(result).toEqual({
      allowed: true,
      reason: 'intent-allowed'
    });
  });

  it('allows an intent exactly at the output limit', () => {
    const result = validateIntentAllowlist(
      { outputSol: 0.5 },
      { maxOutputSol: 0.5 }
    );

    expect(result).toEqual({
      allowed: true,
      reason: 'intent-allowed'
    });
  });

  it('blocks an intent exceeding the output limit', () => {
    const result = validateIntentAllowlist(
      { outputSol: 1.0, side: 'add-lp' },
      { maxOutputSol: 0.5 }
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('output-sol-exceeds-allowlist-limit');
  });

  it('keeps legacy intents without a side capped by the output limit', () => {
    const result = validateIntentAllowlist(
      { outputSol: 1.0 },
      { maxOutputSol: 0.5 }
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('output-sol-exceeds-allowlist-limit');
  });

  it('allows exposure-reducing exits above the opening output limit', () => {
    for (const side of ['withdraw-lp', 'sell', 'claim-fee']) {
      const result = validateIntentAllowlist(
        { outputSol: 1.0, side },
        { maxOutputSol: 0.5 }
      );

      expect(result).toEqual({
        allowed: true,
        reason: 'intent-allowed'
      });
    }
  });
});
