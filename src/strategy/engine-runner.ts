import { buildLargePoolDecision } from './engines/large-pool-engine.ts';
import { buildNewTokenDecision } from './engines/new-token-engine.ts';
import { evaluateEntryEconomicEdge } from './entry-edge.ts';
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
        reasons?: string[];
        secondaryReason?: string;
      };
    }
  | {
      action: 'deploy' | 'dca-out' | 'add-lp' | 'withdraw-lp' | 'claim-fee' | 'rebalance-lp';
      audit: {
        reason: string;
        reasons?: string[];
        secondaryReason?: string;
      };
    };

export function runEngineCycle(input: RunnerInput): EngineCycleResult {
  const shouldApplyEntryHardGates = !(input.engine === 'new-token' && Boolean(input.snapshot.hasLpPosition));
  const gates = shouldApplyEntryHardGates ? evaluateHardGates(
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
  ) : { accepted: true, reasons: [] };

  if (!gates.accepted) {
    return {
      action: 'hold' as const,
      audit: {
        reason: gates.reasons.join(',')
      }
    };
  }

  const shouldApplyEntryEdgeGate = input.engine === 'new-token'
    && Boolean(input.snapshot.inSession)
    && !Boolean(input.snapshot.hasInventory)
    && !Boolean(input.snapshot.hasLpPosition);
  if (shouldApplyEntryEdgeGate) {
    const entryEdge = evaluateEntryEconomicEdge({
      requestedPositionSol: typeof input.snapshot.requestedPositionSol === 'number' ? input.snapshot.requestedPositionSol : undefined,
      expectedFeeSol: typeof input.snapshot.expectedFeeSol === 'number' ? input.snapshot.expectedFeeSol : undefined,
      feeTvlRatio24h: typeof input.snapshot.feeTvlRatio24h === 'number' ? input.snapshot.feeTvlRatio24h : undefined,
      adverseSelectionCostSol: typeof input.snapshot.adverseSelectionCostSol === 'number' ? input.snapshot.adverseSelectionCostSol : undefined,
      adverseSelectionBps: typeof input.snapshot.adverseSelectionBps === 'number' ? input.snapshot.adverseSelectionBps : undefined,
      impermanentLossCostSol: typeof input.snapshot.impermanentLossCostSol === 'number' ? input.snapshot.impermanentLossCostSol : undefined,
      impermanentLossBps: typeof input.snapshot.impermanentLossBps === 'number' ? input.snapshot.impermanentLossBps : undefined,
      roundTripCostSol: typeof input.snapshot.roundTripCostSol === 'number' ? input.snapshot.roundTripCostSol : undefined,
      roundTripCostBps: typeof input.snapshot.roundTripCostBps === 'number' ? input.snapshot.roundTripCostBps : undefined,
      roundtripImpactBps: typeof input.snapshot.roundtripImpactBps === 'number' ? input.snapshot.roundtripImpactBps : undefined,
      impactBps: typeof input.snapshot.impactBps === 'number' ? input.snapshot.impactBps : undefined,
      slippageBps: typeof input.snapshot.slippageBps === 'number' ? input.snapshot.slippageBps : undefined,
      chainCostSol: typeof input.snapshot.chainCostSol === 'number' ? input.snapshot.chainCostSol : undefined,
      chainCostBps: typeof input.snapshot.chainCostBps === 'number' ? input.snapshot.chainCostBps : undefined,
      capitalChargeSol: typeof input.snapshot.capitalChargeSol === 'number' ? input.snapshot.capitalChargeSol : undefined,
      capitalChargeBps: typeof input.snapshot.capitalChargeBps === 'number' ? input.snapshot.capitalChargeBps : undefined,
      safetyMarginSol: typeof input.snapshot.safetyMarginSol === 'number' ? input.snapshot.safetyMarginSol : undefined,
      safetyMarginBps: typeof input.snapshot.safetyMarginBps === 'number' ? input.snapshot.safetyMarginBps : undefined
    }, {
      requirePositiveExpectedEdge: input.config.requirePositiveExpectedEdge === true,
      defaultAdverseSelectionBps: typeof input.config.entryEdgeDefaultAdverseSelectionBps === 'number'
        ? input.config.entryEdgeDefaultAdverseSelectionBps
        : undefined,
      defaultImpermanentLossBps: typeof input.config.entryEdgeDefaultImpermanentLossBps === 'number'
        ? input.config.entryEdgeDefaultImpermanentLossBps
        : undefined,
      defaultChainCostSol: typeof input.config.entryEdgeDefaultChainCostSol === 'number'
        ? input.config.entryEdgeDefaultChainCostSol
        : undefined,
      defaultCapitalChargeBps: typeof input.config.entryEdgeDefaultCapitalChargeBps === 'number'
        ? input.config.entryEdgeDefaultCapitalChargeBps
        : undefined,
      defaultSafetyMarginBps: typeof input.config.entryEdgeDefaultSafetyMarginBps === 'number'
        ? input.config.entryEdgeDefaultSafetyMarginBps
        : undefined
    });

    if (!entryEdge.accepted) {
      return {
        action: 'hold' as const,
        audit: {
          reason: [
            entryEdge.reason,
            `netEdgeSol=${entryEdge.netEdgeSol.toFixed(9)}`,
            `requiredEdgeSol=${entryEdge.requiredEdgeSol.toFixed(9)}`,
            `expectedFeeSol=${entryEdge.expectedFeeSol.toFixed(9)}`,
            `roundTripCostSol=${entryEdge.roundTripCostSol.toFixed(9)}`,
            `chainCostSol=${entryEdge.chainCostSol.toFixed(9)}`
          ].join('|')
        }
      };
    }
  }

  const decision = input.engine === 'new-token'
      ? buildNewTokenDecision(
        {
          inSession: Boolean(input.snapshot.inSession),
          hasInventory: Boolean(input.snapshot.hasInventory),
          unrealizedPct: typeof input.snapshot.unrealizedPct === 'number' ? input.snapshot.unrealizedPct : undefined,
          hasLpPosition: Boolean(input.snapshot.hasLpPosition),
          lpRiskIntent: typeof input.snapshot.lpRiskIntent === 'string' ? input.snapshot.lpRiskIntent as any : undefined,
          lpRiskReason: typeof input.snapshot.lpRiskReason === 'string' ? input.snapshot.lpRiskReason : undefined,
          lpNetPnlPct: typeof input.snapshot.lpNetPnlPct === 'number' ? input.snapshot.lpNetPnlPct : undefined,
          lpSolDepletedBins: typeof input.snapshot.lpSolDepletedBins === 'number' ? input.snapshot.lpSolDepletedBins : undefined,
          lpSolExposureStatus: typeof input.snapshot.lpSolExposureStatus === 'string' ? input.snapshot.lpSolExposureStatus as any : undefined,
          lpUnclaimedFeeUsd: typeof input.snapshot.lpUnclaimedFeeUsd === 'number' ? input.snapshot.lpUnclaimedFeeUsd : undefined,
          lpActiveBinStatus: typeof input.snapshot.lpActiveBinStatus === 'string' ? (input.snapshot.lpActiveBinStatus as any) : undefined,
          lpImpermanentLossPct: typeof input.snapshot.lpImpermanentLossPct === 'number' ? input.snapshot.lpImpermanentLossPct : undefined,
          lifecycleState: typeof input.snapshot.lifecycleState === 'string' ? input.snapshot.lifecycleState : undefined,
          holdTimeMs: typeof input.snapshot.holdTimeMs === 'number' ? input.snapshot.holdTimeMs : undefined,
          pendingConfirmationStatus: typeof input.snapshot.pendingConfirmationStatus === 'string' ? input.snapshot.pendingConfirmationStatus as any : undefined
        },
        {
          takeProfitPct: typeof input.config.takeProfitPct === 'number' ? input.config.takeProfitPct : undefined,
          stopLossPct: typeof input.config.stopLossPct === 'number' ? input.config.stopLossPct : undefined,
          maxHoldHours: typeof input.config.maxHoldHours === 'number' ? input.config.maxHoldHours : undefined,
          lpEnabled: Boolean(input.config.lpEnabled),
          lpStopLossNetPnlPct: typeof input.config.lpStopLossNetPnlPct === 'number' ? input.config.lpStopLossNetPnlPct : undefined,
          lpTakeProfitNetPnlPct: typeof input.config.lpTakeProfitNetPnlPct === 'number' ? input.config.lpTakeProfitNetPnlPct : undefined,
          lpMinHoldMinutesBeforeTakeProfit: typeof input.config.lpMinHoldMinutesBeforeTakeProfit === 'number' ? input.config.lpMinHoldMinutesBeforeTakeProfit : undefined,
          lpSolDepletionExitBins: typeof input.config.lpSolDepletionExitBins === 'number' ? input.config.lpSolDepletionExitBins : undefined,
          lpClaimFeeThresholdUsd: typeof input.config.lpClaimFeeThresholdUsd === 'number' ? input.config.lpClaimFeeThresholdUsd : undefined,
          lpRebalanceOnOutOfRange: Boolean(input.config.lpRebalanceOnOutOfRange),
          lpMaxImpermanentLossPct: typeof input.config.lpMaxImpermanentLossPct === 'number' ? input.config.lpMaxImpermanentLossPct : undefined
        }
      )
    : buildLargePoolDecision();

  return {
    action: decision.action,
    audit: {
      reason: ('reason' in decision) ? (decision.reason as string) : 'decision-generated',
      reasons: 'reasons' in decision ? decision.reasons : undefined,
      secondaryReason: 'secondaryReason' in decision ? decision.secondaryReason : undefined
    }
  };
}
