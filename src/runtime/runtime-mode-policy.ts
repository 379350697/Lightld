import type { RuntimeMode } from './state-types.ts';

export function deriveRuntimeMode(input: {
  currentMode: RuntimeMode;
  quoteFailures: number;
  reconcileFailures: number;
  hasUnknownSubmissionOutcome: boolean;
  cooldownActive: boolean;
  flattenOnlyRequested: boolean;
}) {
  if (input.currentMode === 'paused') {
    return {
      mode: 'paused' as const,
      reason: 'paused'
    };
  }

  if (input.flattenOnlyRequested) {
    return {
      mode: 'flatten_only' as const,
      reason: 'flatten-only-requested'
    };
  }

  if (input.hasUnknownSubmissionOutcome) {
    return {
      mode: 'circuit_open' as const,
      reason: 'unknown-submission-outcome'
    };
  }

  if (input.reconcileFailures >= 2) {
    return {
      mode: 'circuit_open' as const,
      reason: 'reconcile-failures'
    };
  }

  if (input.quoteFailures >= 5) {
    return {
      mode: 'circuit_open' as const,
      reason: 'quote-failures'
    };
  }

  if (input.cooldownActive) {
    return {
      mode: 'recovering' as const,
      reason: 'cooldown-active'
    };
  }

  if (input.quoteFailures >= 3) {
    return {
      mode: 'degraded' as const,
      reason: 'quote-degraded'
    };
  }

  return {
    mode: 'healthy' as const,
    reason: 'healthy'
  };
}
