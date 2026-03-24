import type { LiveCycleResult } from './live-cycle.ts';
import type { RuntimeMode } from './state-types.ts';

export function applyRuntimeActionPolicy(input: {
  mode: RuntimeMode;
  action: LiveCycleResult['action'];
}) {
  if (input.mode === 'paused') {
    return {
      action: 'hold' as const,
      blockedReason: 'runtime-paused'
    };
  }

  if (input.mode === 'recovering') {
    return {
      action: 'hold' as const,
      blockedReason: 'runtime-recovering'
    };
  }

  if (input.mode === 'circuit_open' && input.action === 'deploy') {
    return {
      action: 'hold' as const,
      blockedReason: 'runtime-circuit-open'
    };
  }

  if (input.mode === 'flatten_only' && input.action === 'deploy') {
    return {
      action: 'hold' as const,
      blockedReason: 'runtime-flatten-only'
    };
  }

  return {
    action: input.action,
    blockedReason: ''
  };
}
