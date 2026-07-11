import { z } from 'zod';
import { join } from 'node:path';

import { readJsonIfExists, writeJsonAtomically } from './atomic-file.ts';

export const DeploymentGateBlockingReasonV2Schema = z.enum([
  'p0_not_accepted',
  'p1_not_accepted',
  'insufficient_shadow_days',
  'insufficient_stage_days',
  'insufficient_finalized_episodes',
  'identity_mismatch',
  'reconciliation_mismatch',
  'data_integrity_violation',
  'slo_violation',
  'nonpositive_after_cost_live_net_pnl',
  'tail_risk_worse_than_shadow_or_oos',
  'failure_route_impact_latency_slo_failed',
  'risk_increase_over_2x',
  'missing_human_approval',
  'disaster_event_observed',
  'premature_disaster_rate_claim'
]);
export type DeploymentGateBlockingReasonV2 = z.infer<typeof DeploymentGateBlockingReasonV2Schema>;

export const DeploymentGateInputV2Schema = z.object({
  schemaVersion: z.literal(2),
  gateId: z.string().min(1),
  evaluatedAt: z.string().datetime({ offset: true }),
  fromMode: z.enum(['economic-shadow', 'canary']),
  targetMode: z.enum(['canary', 'live']),
  p0Accepted: z.boolean(),
  p1Accepted: z.boolean(),
  observationDays: z.number().finite().nonnegative(),
  finalizedEpisodeCount: z.number().int().nonnegative(),
  identityMismatchCount: z.number().int().nonnegative(),
  reconciliationMismatchCount: z.number().int().nonnegative(),
  dataIntegrityViolationCount: z.number().int().nonnegative(),
  sloViolationCount: z.number().int().nonnegative(),
  afterCostLiveNetPnlSol: z.number().finite().optional(),
  tailRiskNotWorseThanShadowOrOos: z.boolean().optional(),
  failureRouteImpactLatencySloPassed: z.boolean().optional(),
  requestedRiskMultiple: z.number().finite().positive().optional(),
  humanApproved: z.boolean(),
  disasterEventCount: z.number().int().nonnegative().default(0),
  claimedDisasterRateBelowOnePct: z.boolean().default(false)
}).strict();
export type DeploymentGateInputV2 = z.infer<typeof DeploymentGateInputV2Schema>;

export const DeploymentGateDecisionV2Schema = z.object({
  schemaVersion: z.literal(2),
  gateId: z.string().min(1),
  evaluatedAt: z.string().datetime({ offset: true }),
  fromMode: z.enum(['economic-shadow', 'canary']),
  targetMode: z.enum(['canary', 'live']),
  status: z.enum(['allowed_for_human_approved_canary', 'allowed_for_human_approved_scale', 'blocked']),
  blockingReasons: z.array(DeploymentGateBlockingReasonV2Schema),
  requiredObservationDays: z.number().finite().positive(),
  requiredFinalizedEpisodes: z.number().int().nonnegative(),
  maxRiskIncreaseMultiple: z.number().finite().positive(),
  disasterRateClaimAllowed: z.boolean()
}).strict();
export type DeploymentGateDecisionV2 = z.infer<typeof DeploymentGateDecisionV2Schema>;

const MIN_SHADOW_DAYS = 14;
const MIN_STAGE_DAYS = 14;
const MIN_SCALE_FINALIZED_EPISODES = 100;
const MIN_DISASTER_RATE_DENOMINATOR = 300;
const MAX_RISK_INCREASE_MULTIPLE = 2;

export function evaluateDeploymentGateV2(
  rawInput: z.input<typeof DeploymentGateInputV2Schema>
): DeploymentGateDecisionV2 {
  const input = DeploymentGateInputV2Schema.parse(rawInput);
  const reasons: DeploymentGateBlockingReasonV2[] = [];
  const isFirstCanary = input.fromMode === 'economic-shadow' && input.targetMode === 'canary';

  if (!input.p0Accepted) reasons.push('p0_not_accepted');
  if (!input.p1Accepted) reasons.push('p1_not_accepted');
  if (input.identityMismatchCount > 0) reasons.push('identity_mismatch');
  if (input.reconciliationMismatchCount > 0) reasons.push('reconciliation_mismatch');
  if (input.dataIntegrityViolationCount > 0) reasons.push('data_integrity_violation');
  if (input.sloViolationCount > 0) reasons.push('slo_violation');
  if (input.disasterEventCount > 0) reasons.push('disaster_event_observed');

  if (isFirstCanary) {
    if (input.observationDays < MIN_SHADOW_DAYS) reasons.push('insufficient_shadow_days');
  } else {
    if (input.observationDays < MIN_STAGE_DAYS) reasons.push('insufficient_stage_days');
    if (input.finalizedEpisodeCount < MIN_SCALE_FINALIZED_EPISODES) {
      reasons.push('insufficient_finalized_episodes');
    }
    if ((input.afterCostLiveNetPnlSol ?? Number.NEGATIVE_INFINITY) <= 0) {
      reasons.push('nonpositive_after_cost_live_net_pnl');
    }
    if (input.tailRiskNotWorseThanShadowOrOos !== true) {
      reasons.push('tail_risk_worse_than_shadow_or_oos');
    }
    if (input.failureRouteImpactLatencySloPassed !== true) {
      reasons.push('failure_route_impact_latency_slo_failed');
    }
    if ((input.requestedRiskMultiple ?? Number.POSITIVE_INFINITY) > MAX_RISK_INCREASE_MULTIPLE) {
      reasons.push('risk_increase_over_2x');
    }
  }

  if (!input.humanApproved) {
    reasons.push('missing_human_approval');
  }

  const disasterRateClaimAllowed = input.finalizedEpisodeCount >= MIN_DISASTER_RATE_DENOMINATOR;
  if (input.claimedDisasterRateBelowOnePct && !disasterRateClaimAllowed) {
    reasons.push('premature_disaster_rate_claim');
  }

  return DeploymentGateDecisionV2Schema.parse({
    schemaVersion: 2,
    gateId: input.gateId,
    evaluatedAt: input.evaluatedAt,
    fromMode: input.fromMode,
    targetMode: input.targetMode,
    status: reasons.length > 0
      ? 'blocked'
      : isFirstCanary
        ? 'allowed_for_human_approved_canary'
        : 'allowed_for_human_approved_scale',
    blockingReasons: [...new Set(reasons)],
    requiredObservationDays: isFirstCanary ? MIN_SHADOW_DAYS : MIN_STAGE_DAYS,
    requiredFinalizedEpisodes: isFirstCanary ? 0 : MIN_SCALE_FINALIZED_EPISODES,
    maxRiskIncreaseMultiple: MAX_RISK_INCREASE_MULTIPLE,
    disasterRateClaimAllowed
  });
}

/** A persisted gate is the only authorization for funded modes. */
export class DeploymentGateV2Store {
  private readonly path: string;

  constructor(stateRootDir: string) {
    this.path = join(stateRootDir, 'deployment-gate-v2.json');
  }

  read() {
    return readJsonIfExists(this.path, DeploymentGateDecisionV2Schema);
  }

  async write(decision: z.input<typeof DeploymentGateDecisionV2Schema>) {
    const parsed = DeploymentGateDecisionV2Schema.parse(decision);
    await writeJsonAtomically(this.path, parsed);
    return parsed;
  }
}

export function assertFundedModeAuthorizedV2(
  mode: 'canary' | 'live',
  decision: DeploymentGateDecisionV2 | null
) {
  if (!decision) {
    throw new Error(`Funded mode ${mode} is blocked: no approved DeploymentGateV2 decision is persisted.`);
  }
  if (decision.targetMode !== mode || decision.status === 'blocked') {
    throw new Error(`Funded mode ${mode} is blocked by DeploymentGateV2: ${decision.blockingReasons.join(', ') || 'target-mode-mismatch'}.`);
  }
}
