import { z } from 'zod';

const SessionWindowSchema = z.object({
  start: z.string(),
  end: z.string()
});

export const LiveConfigSchema = z.object({
  enabled: z.boolean(),
  maxLivePositionSol: z.number().positive(),
  autoFlattenRequired: z.boolean(),
  requireWhitelist: z.boolean()
});

export const StrategyConfigSchema = z.object({
  strategyId: z.string(),
  poolClass: z.enum(['new-token', 'large-pool']),
  exitMint: z.literal('SOL'),
  hardGates: z.object({
    requireSolRoute: z.boolean(),
    minLiquidityUsd: z.number().nonnegative()
  }),
  filters: z.object({
    minHolders: z.number().int().positive(),
    minLiquidityUsd: z.number().nonnegative()
  }),
  scoringWeights: z.object({
    holders: z.number(),
    liquidity: z.number(),
    momentum: z.number()
  }),
  riskThresholds: z.object({
    maxPositionSol: z.number().positive(),
    maxDailyLossSol: z.number().positive()
  }),
  sessionWindows: z.array(SessionWindowSchema).min(1),
  solRouteLimits: z.object({
    maxSlippageBps: z.number().int().nonnegative(),
    maxImpactBps: z.number().int().nonnegative()
  }),
  live: LiveConfigSchema
});

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
