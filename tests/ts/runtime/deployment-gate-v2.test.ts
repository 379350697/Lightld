import { describe, expect, it } from 'vitest';

import {
  evaluateDeploymentGateV2,
  type DeploymentGateInputV2
} from '../../../src/runtime/deployment-gate-v2';

function baseGate(overrides: Partial<DeploymentGateInputV2> = {}): DeploymentGateInputV2 {
  return {
    schemaVersion: 2,
    gateId: 'gate-1',
    evaluatedAt: '2026-07-10T00:00:00.000Z',
    fromMode: 'economic-shadow',
    targetMode: 'canary',
    p0Accepted: true,
    p1Accepted: true,
    observationDays: 14,
    finalizedEpisodeCount: 0,
    identityMismatchCount: 0,
    reconciliationMismatchCount: 0,
    dataIntegrityViolationCount: 0,
    sloViolationCount: 0,
    humanApproved: true,
    disasterEventCount: 0,
    claimedDisasterRateBelowOnePct: false,
    ...overrides
  };
}

describe('evaluateDeploymentGateV2', () => {
  it('blocks first canary until P0/P1, fourteen shadow days and clean integrity/SLO evidence pass', () => {
    const decision = evaluateDeploymentGateV2(baseGate({
      p0Accepted: false,
      p1Accepted: false,
      observationDays: 13.99,
      reconciliationMismatchCount: 1,
      sloViolationCount: 1,
      humanApproved: false
    }));

    expect(decision.status).toBe('blocked');
    expect(decision.blockingReasons).toEqual(expect.arrayContaining([
      'p0_not_accepted',
      'p1_not_accepted',
      'insufficient_shadow_days',
      'reconciliation_mismatch',
      'slo_violation',
      'missing_human_approval'
    ]));
  });

  it('allows the first canary only as a human-approved canary gate, not an auto-live promotion', () => {
    const decision = evaluateDeploymentGateV2(baseGate());

    expect(decision).toMatchObject({
      status: 'allowed_for_human_approved_canary',
      blockingReasons: [],
      requiredObservationDays: 14,
      requiredFinalizedEpisodes: 0,
      maxRiskIncreaseMultiple: 2
    });
  });

  it('blocks scale-up unless the stage has 14 days, 100 finalized episodes, positive after-cost live PnL and clean tails/SLOs', () => {
    const decision = evaluateDeploymentGateV2(baseGate({
      fromMode: 'canary',
      targetMode: 'live',
      observationDays: 10,
      finalizedEpisodeCount: 99,
      afterCostLiveNetPnlSol: 0,
      tailRiskNotWorseThanShadowOrOos: false,
      failureRouteImpactLatencySloPassed: false,
      requestedRiskMultiple: 2.01,
      claimedDisasterRateBelowOnePct: true
    }));

    expect(decision.status).toBe('blocked');
    expect(decision.blockingReasons).toEqual(expect.arrayContaining([
      'insufficient_stage_days',
      'insufficient_finalized_episodes',
      'nonpositive_after_cost_live_net_pnl',
      'tail_risk_worse_than_shadow_or_oos',
      'failure_route_impact_latency_slo_failed',
      'risk_increase_over_2x',
      'premature_disaster_rate_claim'
    ]));
    expect(decision.disasterRateClaimAllowed).toBe(false);
  });

  it('allows a human-approved scale gate and permits disaster-rate claims only after 300 finalized episodes', () => {
    const decision = evaluateDeploymentGateV2(baseGate({
      fromMode: 'canary',
      targetMode: 'live',
      observationDays: 14,
      finalizedEpisodeCount: 300,
      afterCostLiveNetPnlSol: 0.01,
      tailRiskNotWorseThanShadowOrOos: true,
      failureRouteImpactLatencySloPassed: true,
      requestedRiskMultiple: 2,
      claimedDisasterRateBelowOnePct: true
    }));

    expect(decision).toMatchObject({
      status: 'allowed_for_human_approved_scale',
      blockingReasons: [],
      disasterRateClaimAllowed: true
    });
  });
});
