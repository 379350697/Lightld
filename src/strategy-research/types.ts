import { z } from 'zod';

import { StrategyConfigSchema } from '../config/schema.ts';

export const RESEARCH_REVIEW_FLOORS = {
  minimumEpisodes: 50,
  minimumUtcDays: 7,
  minimumOosEpisodes: 15,
  minimumMarkCoverage: 0.9
} as const;

export const RESEARCH_ENTRY_MAX_DELAY_MINUTES = 5;
export const RESEARCH_HORIZON_TOLERANCE_MINUTES = {
  15: 5,
  60: 10,
  240: 30,
  480: 60,
  1440: 120
} as const;

export const RESEARCH_HORIZONS = [15, 60, 240, 480, 1440] as const;
export type ResearchHorizonMinutes = (typeof RESEARCH_HORIZONS)[number];

export const ResearchStrategyIdSchema = z.enum(['new-token-v1', 'large-pool-v1']);

export const ResearchVariantSchema = z.object({
  variantId: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  parameterPatch: z.record(z.string(), z.unknown())
});

export const StrategyResearchSpecSchema = z.object({
  experimentId: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  strategyId: ResearchStrategyIdSchema,
  positionSol: z.number().positive().default(1),
  baseConfig: StrategyConfigSchema.optional(),
  variants: z.array(ResearchVariantSchema).min(1).max(3),
  thresholds: z.object({
    minimumEpisodes: z.number().int().min(RESEARCH_REVIEW_FLOORS.minimumEpisodes).default(RESEARCH_REVIEW_FLOORS.minimumEpisodes),
    minimumUtcDays: z.number().int().min(RESEARCH_REVIEW_FLOORS.minimumUtcDays).default(RESEARCH_REVIEW_FLOORS.minimumUtcDays),
    minimumOosEpisodes: z.number().int().min(RESEARCH_REVIEW_FLOORS.minimumOosEpisodes).default(RESEARCH_REVIEW_FLOORS.minimumOosEpisodes),
    minimumMarkCoverage: z.number().min(RESEARCH_REVIEW_FLOORS.minimumMarkCoverage).max(1).default(RESEARCH_REVIEW_FLOORS.minimumMarkCoverage)
  }).default({
    minimumEpisodes: 50,
    minimumUtcDays: 7,
    minimumOosEpisodes: 15,
    minimumMarkCoverage: 0.9
  })
}).superRefine((spec, context) => {
  const ids = spec.variants.map((variant) => variant.variantId);
  if (ids.includes('baseline')) {
    context.addIssue({ code: 'custom', path: ['variants'], message: 'baseline is implicit and cannot be declared as a variant' });
  }
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['variants'], message: 'variantId values must be unique' });
  }
});

export type StrategyResearchSpec = z.infer<typeof StrategyResearchSpecSchema>;

export type ResearchCandidate = {
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  features: Record<string, unknown>;
};

export type ResearchDecision = {
  variantId: string;
  poolAddress: string;
  tokenMint: string;
  selected: boolean;
  eligible: boolean;
  reason: string;
  positionSol: number;
};

export type CaptureResearchSnapshotInput = {
  snapshotId: string;
  experimentId: string;
  strategyId: z.infer<typeof ResearchStrategyIdSchema>;
  observedAt: string;
  captureMode: 'mechanical-soak' | 'economic-shadow';
  candidates: ResearchCandidate[];
  decisions: ResearchDecision[];
};

export type ResearchMarkStatus = 'ok' | 'no_route' | 'dead_pool' | 'rug' | 'unavailable' | 'missed';

export type ResearchEpisode = {
  episodeId: string;
  snapshotId: string;
  experimentId: string;
  strategyId: string;
  variantId: string;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  observedAt: string;
  positionSol: number;
  selected: boolean;
  features: Record<string, unknown>;
  entryStatus: ResearchMarkStatus | null;
  entryDetail: string;
  targetTokenRaw: string | null;
  doubleTokenRaw: string | null;
  entryTargetImpactBps: number | null;
  entryDoubleImpactBps: number | null;
};

export type ResearchMark = {
  episodeId: string;
  horizonMinutes: ResearchHorizonMinutes;
  observedAt: string;
  status: ResearchMarkStatus;
  targetRecoverySol: number | null;
  doubleRecoverySol: number | null;
  targetImpactBps: number | null;
  doubleImpactBps: number | null;
  detail: string;
};

export type StrategyResearchReportStatus = 'insufficient' | 'reject' | 'review';
