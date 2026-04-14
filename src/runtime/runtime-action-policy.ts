import { classifyAction, type LiveAction } from './action-semantics.ts';
import type { RuntimeMode } from './state-types.ts';

export function applyRuntimeActionPolicy(input: {
  mode: RuntimeMode;
  action: LiveAction;
}) {
  const actionClass = classifyAction(input.action);

  if (input.mode === 'paused') {
    return {
      action: 'hold' as const,
      blockedReason: 'runtime-paused'
    };
  }

  if (input.mode === 'recovering') {
    if (actionClass === 'reduce_risk') {
      return {
        action: input.action,
        blockedReason: ''
      };
    }

    return {
      action: 'hold' as const,
      blockedReason: 'runtime-recovering'
    };
  }

  if (input.mode === 'circuit_open') {
    if (actionClass === 'reduce_risk') {
      return {
        action: input.action,
        blockedReason: ''
      };
    }

    return {
      action: 'hold' as const,
      blockedReason: 'runtime-circuit-open'
    };
  }

  if (input.mode === 'flatten_only') {
    if (actionClass === 'reduce_risk') {
      return {
        action: input.action,
        blockedReason: ''
      };
    }

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
