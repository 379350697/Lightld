import { z } from 'zod';

const SessionWindowSchema = z.object({
  start: z.string(),
  end: z.string()
});

export const LiveConfigSchema = z.object({
  enabled: z.boolean(),
  maxLivePositionSol: z.number().positive(),
  autoFlattenRequired: z.boolean(),
  requireWhitelist: z.boolean(),
  minDeployScore: z.number().nonnegative().default(70),
  
  // Strict Rug Guards
  requireMintAuthorityRevoked: z.boolean().default(false),
  requireLpBurnedPct: z.number().nonnegative().max(100).optional(),
  maxTop10HoldersPct: z.number().nonnegative().max(100).optional()
});

export const LpConfigSchema = z.object({
  enabled: z.boolean(),
  singleSideMint: z.literal('SOL'),
  strategyType: z.literal('bid-ask'),
  /** Downside coverage percentage for LP range (default 66) */
  downsideCoveragePct: z.number().min(1).max(99).default(66),
  /** Net PnL stop-loss threshold (%) — fees + principal loss */
  stopLossNetPnlPct: z.number().positive().default(20),
  /** Net PnL take-profit threshold (%) — fees + principal gain */
  takeProfitNetPnlPct: z.number().positive().default(30),
  /** Minimum bin step for pool selection (default 100) */
  minBinStep: z.number().int().positive().default(100),
  /** Minimum 24h volume in USD */
  minVolume24hUsd: z.number().nonnegative().default(1000),
  /** Minimum 24h fee/tvl ratio (0 = no filter) */
  minFeeTvlRatio24h: z.number().nonnegative().default(0)
});

export const StrategyConfigSchema = z.object({
  strategyId: z.string(),
  poolClass: z.enum(['new-token', 'large-pool']),
  exitMint: z.literal('SOL'),
  lpConfig: LpConfigSchema.optional(),
  hardGates: z.object({
    requireSolRoute: z.boolean(),
    minLiquidityUsd: z.number().nonnegative(),
    minPoolAgeMinutes: z.number().nonnegative().optional(),
    maxPoolAgeMinutes: z.number().nonnegative().optional()
  }),
  filters: z.object({
    minHolders: z.number().int().nonnegative(),
    minLiquidityUsd: z.number().nonnegative()
  }),
  scoringWeights: z.object({
    holders: z.number(),
    liquidity: z.number(),
    momentum: z.number()
  }),
  riskThresholds: z.object({
    maxPositionSol: z.number().positive(),
    maxDailyLossSol: z.number().positive(),
    takeProfitPct: z.number().positive().optional(),
    stopLossPct: z.number().positive().optional()
  }),
  sessionWindows: z.array(SessionWindowSchema).min(1),
  solRouteLimits: z.object({
    maxSlippageBps: z.number().int().nonnegative(),
    maxImpactBps: z.number().int().nonnegative()
  }),
  live: LiveConfigSchema
});

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
