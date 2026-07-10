import { describe, expect, it } from 'vitest';

import {
  aggregateExecutionSloV2,
  type ExecutionSloObservationV2
} from '../../../src/runtime/execution-slo-v2';

function observation(
  override: Partial<ExecutionSloObservationV2> = {}
): ExecutionSloObservationV2 {
  return {
    mode: 'canary',
    orderId: 'order-1',
    executable: true,
    safetyRejected: false,
    landed: true,
    finalized: true,
    terminalOutcome: 'finalized',
    failureOccurred: false,
    identityMismatch: false,
    unexplainedReconciliationDelta: false,
    quoteToLandMs: 9_000,
    landToFinalizedMs: 45_000,
    signedMaxSlippageBps: 100,
    actualSlippageBps: 80,
    signedMaxImpactBps: 150,
    actualImpactBps: 120,
    signedMaxTotalFeeLamports: 50_000,
    actualTotalFeeLamports: 40_000,
    ...override
  };
}

describe('aggregateExecutionSloV2', () => {
  it('passes the complete execution SLO only when every hard invariant passes', () => {
    const report = aggregateExecutionSloV2([observation()], '2026-07-10T04:01:00.000Z');
    const canary = report.modes[0];

    expect(canary.mode).toBe('canary');
    expect(canary.failureTaxonomyCompletenessPct).toBe(100);
    expect(canary.unknownTerminalOutcomeCount).toBe(0);
    expect(canary.notSubmittedReasonCompletenessPct).toBe(100);
    expect(canary.identityMismatchCount).toBe(0);
    expect(canary.unexplainedReconciliationDeltaCount).toBe(0);
    expect(canary.quoteToLandP95Ms).toBe(9_000);
    expect(canary.landToFinalizedP95Ms).toBe(45_000);
    expect(canary.landingRatePct).toBe(100);
    expect(canary.signedEnvelopeBreachCount).toBe(0);
    expect(canary.status).toBe('pass');
  });

  it('excludes safety rejections from the landing denominator', () => {
    const report = aggregateExecutionSloV2([
      observation(),
      observation({
        orderId: 'safety-reject',
        safetyRejected: true,
        executable: false,
        landed: false,
        finalized: false,
        terminalOutcome: 'not_submitted',
        failureKind: 'safety',
        failureOperation: 'preflight',
        failureReason: 'gmgn-source-failed',
        quoteToLandMs: undefined,
        landToFinalizedMs: undefined,
        signedMaxSlippageBps: undefined,
        actualSlippageBps: undefined,
        signedMaxImpactBps: undefined,
        actualImpactBps: undefined,
        signedMaxTotalFeeLamports: undefined,
        actualTotalFeeLamports: undefined
      })
    ]);

    expect(report.modes[0].landingEligibleCount).toBe(1);
    expect(report.modes[0].landingRatePct).toBe(100);
    expect(report.modes[0].notSubmittedReasonCompletenessPct).toBe(100);
  });

  it('fails closed when not-submitted orders lack a structured reason', () => {
    const report = aggregateExecutionSloV2([
      observation(),
      observation({
        orderId: 'not-submitted-without-reason',
        landed: false,
        finalized: false,
        terminalOutcome: 'not_submitted',
        quoteToLandMs: undefined,
        landToFinalizedMs: undefined
      })
    ]);
    const canary = report.modes[0];

    expect(canary.notSubmittedCount).toBe(1);
    expect(canary.completeNotSubmittedReasonCount).toBe(0);
    expect(canary.notSubmittedReasonCompletenessPct).toBe(0);
    expect(canary.violations).toContain('not-submitted-reason-incomplete');
    expect(canary.status).toBe('fail');
  });

  it('fails incomplete failure taxonomy, unknown outcomes, reconciliation, latency and envelopes', () => {
    const report = aggregateExecutionSloV2([observation({
      failureOccurred: true,
      failureKind: 'rpc',
      failureOperation: undefined,
      failureReason: undefined,
      terminalOutcome: 'unknown',
      identityMismatch: true,
      unexplainedReconciliationDelta: true,
      quoteToLandMs: 10_001,
      landToFinalizedMs: 60_001,
      actualSlippageBps: 101,
      actualImpactBps: 151,
      actualTotalFeeLamports: 50_001
    })]);
    const canary = report.modes[0];

    expect(canary.failureTaxonomyCompletenessPct).toBe(0);
    expect(canary.unknownTerminalOutcomeCount).toBe(1);
    expect(canary.identityMismatchCount).toBe(1);
    expect(canary.unexplainedReconciliationDeltaCount).toBe(1);
    expect(canary.signedEnvelopeBreachCount).toBe(1);
    expect(canary.signedEnvelopeSlippageBreachCount).toBe(1);
    expect(canary.signedEnvelopeImpactBreachCount).toBe(1);
    expect(canary.signedEnvelopeFeeBreachCount).toBe(1);
    expect(canary.status).toBe('fail');
  });

  it('never combines observations or PnL-like execution metrics across runtime modes', () => {
    const report = aggregateExecutionSloV2([
      observation({ mode: 'live', orderId: 'live-1' }),
      observation({
        mode: 'mechanical-soak',
        orderId: 'soak-1',
        terminalOutcome: 'unknown',
        landed: false,
        finalized: false,
        quoteToLandMs: undefined,
        landToFinalizedMs: undefined
      })
    ]);

    expect(report.modes.map((entry) => entry.mode)).toEqual(['mechanical-soak', 'live']);
    expect(report.modes.find((entry) => entry.mode === 'live')?.status).toBe('pass');
    expect(report.modes.find((entry) => entry.mode === 'mechanical-soak')?.status).toBe('fail');
    expect(report).not.toHaveProperty('combined');
    expect(report).not.toHaveProperty('total');
  });
});
