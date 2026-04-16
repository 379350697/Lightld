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
      action: 'deploy' | 'dca-out' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';
      audit: {
        reason: string;
      };
    };

export function runEngineCycle(input: RunnerInput): EngineCycleResult {
  const gates = evaluateHardGates(
    {
      hasSolRoute: Boolean(input.snapshot.hasSolRoute),
      liquidityUsd: typeof input.snapshot.liquidityUsd === 'number' ? input.snapshot.liquidityUsd : undefined,
      poolCreatedAt: typeof input.snapshot.poolCreatedAt === 'string' ? input.snapshot.poolCreatedAt : undefined
    },
    {
      requireSolRoute: Boolean(input.config.requireSolRoute),
      minLiquidityUsd: typeof input.config.minLiquidityUsd === 'number' ? input.config.minLiquidityUsd : undefined,
      minPoolAgeMinutes: typeof input.config.minPoolAgeMinutes === 'number' ? input.config.minPoolAgeMinutes : undefined,
      maxPoolAgeMinutes: typeof input.config.maxPoolAgeMinutes === 'number' ? input.config.maxPoolAgeMinutes : undefined
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
      ? buildNewTokenDecision(
        {
          inSession: Boolean(input.snapshot.inSession),
          hasInventory: Boolean(input.snapshot.hasInventory),
          unrealizedPct: typeof input.snapshot.unrealizedPct === 'number' ? input.snapshot.unrealizedPct : undefined,
          hasLpPosition: Boolean(input.snapshot.hasLpPosition),
          lpNetPnlPct: typeof input.snapshot.lpNetPnlPct === 'number' ? input.snapshot.lpNetPnlPct : undefined,
          lpUnclaimedFeeUsd: typeof input.snapshot.lpUnclaimedFeeUsd === 'number' ? input.snapshot.lpUnclaimedFeeUsd : undefined,
          lpActiveBinStatus: typeof input.snapshot.lpActiveBinStatus === 'string' ? (input.snapshot.lpActiveBinStatus as any) : undefined,
          lpImpermanentLossPct: typeof input.snapshot.lpImpermanentLossPct === 'number' ? input.snapshot.lpImpermanentLossPct : undefined,
          lifecycleState: typeof input.snapshot.lifecycleState === 'string' ? input.snapshot.lifecycleState : undefined
        },
        {
          takeProfitPct: typeof input.config.takeProfitPct === 'number' ? input.config.takeProfitPct : undefined,
          stopLossPct: typeof input.config.stopLossPct === 'number' ? input.config.stopLossPct : undefined,
          lpEnabled: Boolean(input.config.lpEnabled),
          lpStopLossNetPnlPct: typeof input.config.lpStopLossNetPnlPct === 'number' ? input.config.lpStopLossNetPnlPct : undefined,
          lpTakeProfitNetPnlPct: typeof input.config.lpTakeProfitNetPnlPct === 'number' ? input.config.lpTakeProfitNetPnlPct : undefined,
          lpClaimFeeThresholdUsd: typeof input.config.lpClaimFeeThresholdUsd === 'number' ? input.config.lpClaimFeeThresholdUsd : undefined,
          lpRebalanceOnOutOfRange: Boolean(input.config.lpRebalanceOnOutOfRange),
          lpMaxImpermanentLossPct: typeof input.config.lpMaxImpermanentLossPct === 'number' ? input.config.lpMaxImpermanentLossPct : undefined
        }
      )
    : buildLargePoolDecision();

  return {
    action: decision.action,
    audit: {
      reason: ('reason' in decision) ? (decision.reason as string) : 'decision-generated'
    }
  };
}
