import { z } from 'zod';

import { StrategyConfigSchema } from '../config/schema.ts';

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
    minimumEpisodes: z.number().int().positive().default(50),
    minimumUtcDays: z.number().int().positive().default(7),
    minimumOosEpisodes: z.number().int().positive().default(15),
    minimumMarkCoverage: z.number().min(0).max(1).default(0.9)
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

export type ResearchMarkStatus = 'ok' | 'no_route' | 'dead_pool' | 'rug' | 'unavailable';

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
};

export type ResearchMark = {
  episodeId: string;
  horizonMinutes: 15 | 60 | 240 | 1440;
  observedAt: string;
  status: ResearchMarkStatus;
  targetRecoverySol: number | null;
  doubleRecoverySol: number | null;
  targetImpactBps: number | null;
  doubleImpactBps: number | null;
  detail: string;
};

export type StrategyResearchReportStatus = 'insufficient' | 'reject' | 'review';
