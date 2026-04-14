import { describe, expect, it } from 'vitest';

import { deriveRuntimeMode } from '../../../src/runtime/runtime-mode-policy';

describe('deriveRuntimeMode', () => {
  it('opens the circuit when a submission outcome is unknown', () => {
    expect(
      deriveRuntimeMode({
        currentMode: 'healthy',
        quoteFailures: 0,
        reconcileFailures: 0,
        hasUnknownSubmissionOutcome: true,
        cooldownActive: false,
        flattenOnlyRequested: false
      })
    ).toEqual({
      mode: 'circuit_open',
      reason: 'unknown-submission-outcome'
    });
  });

  it('degrades after moderate quote failures and recovers after cooldown', () => {
    expect(
      deriveRuntimeMode({
        currentMode: 'healthy',
        quoteFailures: 3,
        reconcileFailures: 0,
        hasUnknownSubmissionOutcome: false,
        cooldownActive: false,
        flattenOnlyRequested: false
      })
    ).toEqual({
      mode: 'degraded',
      reason: 'quote-degraded'
    });

    expect(
      deriveRuntimeMode({
        currentMode: 'circuit_open',
        quoteFailures: 0,
        reconcileFailures: 0,
        hasUnknownSubmissionOutcome: false,
        cooldownActive: true,
        flattenOnlyRequested: false
      })
    ).toEqual({
      mode: 'recovering',
      reason: 'cooldown-active'
    });
  });
});
