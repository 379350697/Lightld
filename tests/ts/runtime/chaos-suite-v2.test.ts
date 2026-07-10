import { describe, expect, it } from 'vitest';

import {
  CHAOS_SCENARIOS_V2,
  evaluateChaosSuiteV2,
  type ChaosRunV2,
  type ChaosScenarioV2
} from '../../../src/runtime/chaos-suite-v2';

function run(
  scenario: ChaosScenarioV2,
  overrides: Partial<ChaosRunV2> = {}
): ChaosRunV2 {
  return {
    schemaVersion: 2,
    scenario,
    runId: `chaos-${scenario}`,
    mode: 'economic-shadow',
    startedAt: '2026-07-10T00:00:00.000Z',
    finishedAt: '2026-07-10T00:01:00.000Z',
    acceptance: {
      noDuplicateOpen: true,
      noOrphanPosition: true,
      pendingRecoveredFromOutboxAndChain: true,
      noUnexplainedBalanceDelta: true,
      exitCapabilityPreserved: true,
      healthNotFalseHealthy: true
    },
    evidenceRefs: [`state/chaos/${scenario}.json`],
    ...overrides
  };
}

describe('evaluateChaosSuiteV2', () => {
  it('fails closed when any required scenario is missing', () => {
    const report = evaluateChaosSuiteV2([
      run('crash_after_reserve')
    ], '2026-07-10T00:02:00.000Z');

    expect(report.status).toBe('fail');
    expect(report.requiredScenarioCount).toBe(CHAOS_SCENARIOS_V2.length);
    expect(report.observedScenarioCount).toBe(1);
    expect(report.missingScenarios).toContain('duplicate_intent');
    expect(report.missingScenarios).toContain('shutdown_with_pending');
  });

  it('fails a scenario when health is falsely healthy or recovery invariants are not proven', () => {
    const report = evaluateChaosSuiteV2(CHAOS_SCENARIOS_V2.map((scenario) => run(
      scenario,
      scenario === 'rpc_partition_or_rate_limit'
        ? {
            acceptance: {
              noDuplicateOpen: true,
              noOrphanPosition: true,
              pendingRecoveredFromOutboxAndChain: false,
              noUnexplainedBalanceDelta: true,
              exitCapabilityPreserved: true,
              healthNotFalseHealthy: false
            }
          }
        : {}
    )));

    expect(report.status).toBe('fail');
    expect(report.failedScenarios).toEqual(['rpc_partition_or_rate_limit']);
    expect(report.failedInvariants.rpc_partition_or_rate_limit).toEqual([
      'pendingRecoveredFromOutboxAndChain',
      'healthNotFalseHealthy'
    ]);
  });

  it('passes only when every P2 chaos scenario proves all acceptance invariants', () => {
    const report = evaluateChaosSuiteV2(
      CHAOS_SCENARIOS_V2.map((scenario) => run(scenario)),
      '2026-07-10T00:02:00.000Z'
    );

    expect(report).toMatchObject({
      schemaVersion: 2,
      status: 'pass',
      requiredScenarioCount: CHAOS_SCENARIOS_V2.length,
      observedScenarioCount: CHAOS_SCENARIOS_V2.length,
      missingScenarios: [],
      failedScenarios: []
    });
  });
});
