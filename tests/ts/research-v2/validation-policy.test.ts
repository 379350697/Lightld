import { describe, expect, it } from 'vitest';

import {
  PROFESSIONAL_VALIDATION_FLOORS_V2,
  ValidationReportV2Schema,
  evaluateProfessionalValidationV2,
  type ProfessionalValidationInputV2
} from '../../../src/research-v2';

function passingInput(): ProfessionalValidationInputV2 {
  return {
    reportId: 'report-1',
    datasetId: 'dataset-1',
    hypothesisId: 'hypothesis-1',
    generatedAt: '2026-07-01T00:00:00.000Z',
    coverage: {
      independentEpisodes: 500,
      naturalDays: 60,
      untouchedOosEpisodes: 100,
      marketRegimes: 3,
      maxPoolEpisodeContributionPct: 20,
      maxPoolProfitContributionPct: 20,
      maxDeployerEpisodeContributionPct: 20
    },
    dataQuality: {
      datasetSchemaVersion: 2,
      identityMismatchCount: 0,
      duplicatedOutcomeBindingCount: 0,
      invalidV1RowCount: 0,
      untrustedValuationCount: 0,
      unknownTerminalOutcomeCount: 0,
      unreconciledLedgerDeltaSol: 0
    },
    metrics: {
      afterCostArithmeticReturn: 0.01,
      afterCostGeometricReturn: 0.009,
      medianReturn: 0.005,
      trimmedMeanReturn: 0.006,
      profitFactor: 1.2,
      sortinoRatio: 0.9,
      calmarRatio: 0.8,
      oosGeometricReturnLower95: 0.001,
      deflatedSharpePValue: 0.049,
      probabilityOfBacktestOverfitting: 0.199,
      hansenSpaPValue: 0.04,
      bhFdrQValue: 0.04,
      candidateExpectedShortfall95: 0.08,
      baselineExpectedShortfall95: 0.08,
      candidateExpectedShortfall99: 0.12,
      baselineExpectedShortfall99: 0.12,
      candidateMaxDrawdownPct: 0.15,
      baselineMaxDrawdownPct: 0.15,
      lossClusteringScore: 0.2,
      ruinProbability: 0.01,
      capacityDecayAtDoubleSizePct: 0.1,
      regimeDirectionConsistent: true,
      targetSizeExitExecutable: true,
      doubleSizeExitExecutable: true
    }
  };
}

describe('evaluateProfessionalValidationV2', () => {
  it('enforces non-overridable hard sample floors and emits no proposal when data is insufficient', () => {
    const input = passingInput();
    input.coverage.independentEpisodes = 499;

    const report = evaluateProfessionalValidationV2(input);

    expect(PROFESSIONAL_VALIDATION_FLOORS_V2.minimumIndependentEpisodes).toBe(500);
    expect(report).toMatchObject({
      status: 'no_action',
      proposalAllowed: false
    });
    expect(report.blockingReasons).toContain('insufficient_independent_episodes');
  });

  it('fails closed when V1 or identity-contaminated data reaches the policy', () => {
    const input = passingInput();
    input.dataQuality.invalidV1RowCount = 1;
    input.dataQuality.identityMismatchCount = 1;

    const report = evaluateProfessionalValidationV2(input);

    expect(report.status).toBe('no_action');
    expect(report.proposalAllowed).toBe(false);
    expect(report.blockingReasons).toEqual(expect.arrayContaining([
      'contains_invalid_v1_rows',
      'identity_mismatch_detected'
    ]));
  });

  it('rejects sample and accounting contamination before evaluating alpha', () => {
    const input = passingInput();
    input.coverage.maxPoolEpisodeContributionPct = 20.001;
    input.dataQuality.untrustedValuationCount = 1;
    input.dataQuality.unknownTerminalOutcomeCount = 1;
    input.dataQuality.unreconciledLedgerDeltaSol = 0.000_000_001;

    const report = evaluateProfessionalValidationV2(input);

    expect(report.status).toBe('no_action');
    expect(report.proposalAllowed).toBe(false);
    expect(report.blockingReasons).toEqual(expect.arrayContaining([
      'pool_episode_concentration_too_high',
      'untrusted_valuation_detected',
      'unknown_terminal_outcome_detected',
      'unreconciled_ledger_delta_detected'
    ]));
  });

  it('rejects a mature experiment that fails statistical or tail-risk gates', () => {
    const input = passingInput();
    if (input.metrics === null) {
      throw new Error('Passing fixture must include metrics.');
    }
    input.metrics.oosGeometricReturnLower95 = 0;
    input.metrics.probabilityOfBacktestOverfitting = 0.2;
    input.metrics.candidateExpectedShortfall99 = 0.13;

    const report = evaluateProfessionalValidationV2(input);

    expect(report.status).toBe('rejected');
    expect(report.proposalAllowed).toBe(false);
    expect(report.blockingReasons).toEqual(expect.arrayContaining([
      'oos_lower_confidence_bound_not_positive',
      'pbo_not_below_limit',
      'expected_shortfall_99_worse_than_baseline'
    ]));
  });

  it('only makes a passing experiment eligible for human review, never auto-approved', () => {
    const report = evaluateProfessionalValidationV2(passingInput());

    expect(report).toMatchObject({
      status: 'eligible_for_human_review',
      proposalAllowed: true,
      blockingReasons: []
    });
    expect(() => ValidationReportV2Schema.parse({
      ...report,
      status: 'no_action',
      proposalAllowed: true
    })).toThrow();
  });
});
