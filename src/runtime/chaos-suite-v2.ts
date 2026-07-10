import { z } from 'zod';

import { RunModeV2Schema } from './run-manifest-v2.ts';

export const CHAOS_SCENARIOS_V2 = [
  'crash_after_reserve',
  'crash_after_send_before_record',
  'confirmed_before_finalized_stall',
  'rpc_partition_or_rate_limit',
  'gmgn_down',
  'dlmm_valuation_stale',
  'token_rpc_partial',
  'duplicate_intent',
  'db_full_or_wal_lock',
  'disk_warning_70',
  'disk_halt_85',
  'signer_restart',
  'execution_restart',
  'candidate_restart',
  'shutdown_with_pending'
] as const;

export const ChaosScenarioV2Schema = z.enum(CHAOS_SCENARIOS_V2);
export type ChaosScenarioV2 = z.infer<typeof ChaosScenarioV2Schema>;

export const ChaosAcceptanceV2Schema = z.object({
  noDuplicateOpen: z.boolean(),
  noOrphanPosition: z.boolean(),
  pendingRecoveredFromOutboxAndChain: z.boolean(),
  noUnexplainedBalanceDelta: z.boolean(),
  exitCapabilityPreserved: z.boolean(),
  healthNotFalseHealthy: z.boolean()
}).strict();
export type ChaosAcceptanceV2 = z.infer<typeof ChaosAcceptanceV2Schema>;

export const ChaosRunV2Schema = z.object({
  schemaVersion: z.literal(2),
  scenario: ChaosScenarioV2Schema,
  runId: z.string().min(1),
  mode: RunModeV2Schema,
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  acceptance: ChaosAcceptanceV2Schema,
  evidenceRefs: z.array(z.string().min(1)).default([])
}).superRefine((value, context) => {
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['finishedAt'],
      message: 'Chaos run cannot finish before it starts.'
    });
  }
});
export type ChaosRunV2 = z.infer<typeof ChaosRunV2Schema>;

export const ChaosSuiteReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().datetime({ offset: true }),
  status: z.enum(['pass', 'fail']),
  requiredScenarioCount: z.number().int().positive(),
  observedScenarioCount: z.number().int().nonnegative(),
  missingScenarios: z.array(ChaosScenarioV2Schema),
  failedScenarios: z.array(ChaosScenarioV2Schema),
  failedInvariants: z.record(ChaosScenarioV2Schema, z.array(z.string().min(1))),
  runs: z.array(ChaosRunV2Schema)
}).strict();
export type ChaosSuiteReportV2 = z.infer<typeof ChaosSuiteReportV2Schema>;

const ACCEPTANCE_KEYS: Array<keyof ChaosAcceptanceV2> = [
  'noDuplicateOpen',
  'noOrphanPosition',
  'pendingRecoveredFromOutboxAndChain',
  'noUnexplainedBalanceDelta',
  'exitCapabilityPreserved',
  'healthNotFalseHealthy'
];

export function evaluateChaosSuiteV2(
  rawRuns: z.input<typeof ChaosRunV2Schema>[],
  generatedAt = new Date().toISOString()
): ChaosSuiteReportV2 {
  const runs = rawRuns.map((run) => ChaosRunV2Schema.parse(run));
  const observed = new Set(runs.map((run) => run.scenario));
  const missingScenarios = CHAOS_SCENARIOS_V2.filter((scenario) => !observed.has(scenario));
  const failedInvariants = Object.fromEntries(
    CHAOS_SCENARIOS_V2.map((scenario) => [scenario, [] as string[]])
  ) as Record<ChaosScenarioV2, string[]>;

  for (const run of runs) {
    const failed = ACCEPTANCE_KEYS.filter((key) => run.acceptance[key] !== true);
    if (failed.length > 0) {
      failedInvariants[run.scenario].push(...failed);
    }
  }

  const failedScenarios = CHAOS_SCENARIOS_V2.filter((scenario) => failedInvariants[scenario].length > 0);

  return ChaosSuiteReportV2Schema.parse({
    schemaVersion: 2,
    generatedAt,
    status: missingScenarios.length === 0 && failedScenarios.length === 0 ? 'pass' : 'fail',
    requiredScenarioCount: CHAOS_SCENARIOS_V2.length,
    observedScenarioCount: observed.size,
    missingScenarios,
    failedScenarios,
    failedInvariants,
    runs
  });
}
