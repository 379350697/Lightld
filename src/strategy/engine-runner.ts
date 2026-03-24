import { buildLargePoolDecision } from './engines/large-pool-engine.ts';
import { buildNewTokenDecision } from './engines/new-token-engine.ts';
import { evaluateHardGates } from './filtering/hard-gates.ts';

type EngineName = 'new-token' | 'large-pool';

type RunnerInput = {
  engine: EngineName;
  snapshot: Record<string, unknown>;
  config: Record<string, unknown>;
};

type EngineCycleResult =
  | {
      action: 'hold';
      audit: {
        reason: string;
      };
    }
  | {
      action: 'deploy' | 'dca-out';
      audit: {
        reason: string;
      };
    };

export function runEngineCycle(input: RunnerInput): EngineCycleResult {
  const gates = evaluateHardGates(
    {
      hasSolRoute: Boolean(input.snapshot.hasSolRoute),
      liquidityUsd: typeof input.snapshot.liquidityUsd === 'number' ? input.snapshot.liquidityUsd : undefined
    },
    {
      requireSolRoute: Boolean(input.config.requireSolRoute),
      minLiquidityUsd: typeof input.config.minLiquidityUsd === 'number' ? input.config.minLiquidityUsd : undefined
    }
  );

  if (!gates.accepted) {
    return {
      action: 'hold' as const,
      audit: {
        reason: gates.reasons.join(',')
      }
    };
  }

  const decision = input.engine === 'new-token'
    ? buildNewTokenDecision({
        inSession: Boolean(input.snapshot.inSession),
        hasInventory: Boolean(input.snapshot.hasInventory)
      })
    : buildLargePoolDecision(
        {
          score: Number(input.snapshot.score ?? 0)
        },
        {
          minScore: Number(input.config.minScore ?? 0)
        }
      );

  return {
    action: decision.action,
    audit: {
      reason: 'decision-generated'
    }
  };
}
