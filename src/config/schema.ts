import { z } from 'zod';

import { DEFAULT_ROUND_TRIP_CHAIN_COST_SOL } from './economic-defaults.ts';

import { DEFAULT_SOL_DEPLETION_EXIT_BINS } from '../runtime/lp-sol-exposure.ts';

const SessionWindowSchema = z.object({
  start: z.string(),
  end: z.string()
});

export const LiveConfigSchema = z.object({
  enabled: z.boolean(),
  maxLivePositionSol: z.number().positive(),
  autoFlattenRequired: z.boolean(),
  maxHoldHours: z.number().positive().default(18),

  // A3: minimum seconds a position must remain closed before a new
  // open can be initiated.  Acts as a cooling-off guard against
  // rapid reopen loops.
  minCloseToOpenIntervalSeconds: z.number().int().nonnegative().default(60),

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
  /** Withdraw when the single-sided SOL leg has been consumed across this many bins */
  solDepletionExitBins: z.number().int().nonnegative().default(DEFAULT_SOL_DEPLETION_EXIT_BINS),
  /** Minimum bin step for pool selection (default 100) */
  minBinStep: z.number().int().positive().default(100),
  /** Minimum 24h volume in USD */
  minVolume24hUsd: z.number().nonnegative().default(1000),
  /** Minimum 24h fee/tvl ratio (0 = no filter) */
  minFeeTvlRatio24h: z.number().nonnegative().default(0),
  /** Claim fees when unclaimed fee balance reaches threshold */
  claimFeeThresholdUsd: z.number().nonnegative().optional(),
  /** Rebalance when position is out of range */
  rebalanceOnOutOfRange: z.boolean().default(false),
  /** Withdraw LP when impermanent loss reaches threshold */
  maxImpermanentLossPct: z.number().nonnegative().optional()
});

export const AuxiliarySignalProviderNameSchema = z.enum([
  'dexscreener',
  'jupiter',
  'coingecko',
  'birdeye'
]);

const AuxiliarySignalProviderOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  weight: z.number().nonnegative().default(1),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().optional()
});

const DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS = {
  enabled: true,
  weight: 1
};

const DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS_BY_NAME = {
  dexscreener: DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS,
  jupiter: DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS,
  coingecko: DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS,
  birdeye: DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS
};

export const AuxiliarySignalsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.literal('rank-only').default('rank-only'),
  timeoutMs: z.number().int().positive().default(800),
  cacheTtlMs: z.number().int().nonnegative().default(300_000),
  maxCandidatesPerCycle: z.number().int().positive().default(30),
  failOpen: z.boolean().default(true),
  maxScoreBonus: z.number().nonnegative().default(30),
  providers: z.array(AuxiliarySignalProviderNameSchema).default([
    'dexscreener',
    'jupiter',
    'coingecko'
  ]),
  providerOptions: z.object({
    dexscreener: AuxiliarySignalProviderOptionsSchema.default(DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS),
    jupiter: AuxiliarySignalProviderOptionsSchema.default(DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS),
    coingecko: AuxiliarySignalProviderOptionsSchema.default(DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS),
    birdeye: AuxiliarySignalProviderOptionsSchema.default(DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS)
  }).default(DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS_BY_NAME)
}).default({
  enabled: false,
  mode: 'rank-only',
  timeoutMs: 800,
  cacheTtlMs: 300_000,
  maxCandidatesPerCycle: 30,
  failOpen: true,
  maxScoreBonus: 30,
  providers: [
    'dexscreener',
    'jupiter',
    'coingecko'
  ],
  providerOptions: DEFAULT_AUXILIARY_SIGNAL_PROVIDER_OPTIONS_BY_NAME
});

export const StrategyConfigSchema = z.object({
  strategyId: z.string(),
  poolClass: z.enum(['new-token', 'large-pool']),
  exitMint: z.literal('SOL'),
  lpConfig: LpConfigSchema.optional(),
  auxiliarySignals: AuxiliarySignalsConfigSchema,
  hardGates: z.object({
    requireSolRoute: z.boolean(),
    minLiquidityUsd: z.number().nonnegative(),
    minPoolAgeMinutes: z.number().nonnegative().optional(),
    maxPoolAgeMinutes: z.number().nonnegative().optional()
  }),
  filters: z.object({
    minLiquidityUsd: z.number().nonnegative()
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
  entryEdge: z.object({
    enabled: z.boolean().default(false),
    defaultAdverseSelectionBps: z.number().nonnegative().default(25),
    defaultImpermanentLossBps: z.number().nonnegative().default(25),
    defaultChainCostSol: z.number().nonnegative().default(DEFAULT_ROUND_TRIP_CHAIN_COST_SOL),
    defaultCapitalChargeBps: z.number().nonnegative().default(5),
    defaultSafetyMarginBps: z.number().nonnegative().default(10)
  }).optional(),
  live: LiveConfigSchema
});

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type AuxiliarySignalsConfig = z.infer<typeof AuxiliarySignalsConfigSchema>;
export type AuxiliarySignalProviderName = z.infer<typeof AuxiliarySignalProviderNameSchema>;
