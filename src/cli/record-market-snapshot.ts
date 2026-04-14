import {
  buildDecisionContext,
  type DecisionContextInput
} from '../runtime/build-decision-context.ts';

export async function recordMarketSnapshot(input: DecisionContextInput = {}) {
  const context = buildDecisionContext(input);

  return {
    status: 'ok' as const,
    capturedAt: context.createdAt,
    context
  };
}
