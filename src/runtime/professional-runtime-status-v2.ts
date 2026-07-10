import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { resolveEvolutionPaths } from '../evolution/paths.ts';
import { DatasetStatusV1Schema } from '../evolution/dataset-status.ts';
import { RiskStateV2Store, type RiskStateV2 } from '../risk/risk-state-v2.ts';
import { readJsonIfExists, writeJsonAtomically } from './atomic-file.ts';
import { SourceQualityV2Schema } from './dependency-health-v2.ts';
import {
  DurableTransactionOutboxV2,
  type DurableOutboxRecordV2
} from './durable-transaction-outbox-v2.ts';
import {
  RunManifestV2Schema,
  RunModeV2Schema,
  type RunManifestV2,
  type RunModeV2
} from './run-manifest-v2.ts';

export const PnlEvidenceStatusV2Schema = z.enum([
  'synthetic',
  'simulated',
  'exact',
  'partial',
  'untrusted'
]);

export const ModePnlBucketV2Schema = z.object({
  mode: RunModeV2Schema,
  grossPnlSol: z.number().finite().nullable(),
  netPnlSol: z.number().finite().nullable(),
  realizedPnlSol: z.number().finite().nullable(),
  unrealizedPnlSol: z.number().finite().nullable(),
  finalizedEpisodeCount: z.number().int().nonnegative(),
  evidenceStatus: PnlEvidenceStatusV2Schema
}).strict().superRefine((value, context) => {
  if (value.mode === 'mechanical-soak' && value.evidenceStatus !== 'synthetic') {
    context.addIssue({
      code: 'custom',
      path: ['evidenceStatus'],
      message: 'mechanical-soak PnL evidence must be synthetic'
    });
  }
  if (
    value.mode === 'mechanical-soak'
    && (
      value.grossPnlSol !== null
      || value.netPnlSol !== null
      || value.realizedPnlSol !== null
      || value.unrealizedPnlSol !== null
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['netPnlSol'],
      message: 'mechanical-soak may not expose PnL values'
    });
  }
  if (value.mode === 'economic-shadow' && value.evidenceStatus !== 'simulated') {
    context.addIssue({
      code: 'custom',
      path: ['evidenceStatus'],
      message: 'economic-shadow PnL evidence must be simulated'
    });
  }
  if (
    (value.mode === 'canary' || value.mode === 'live')
    && (value.evidenceStatus === 'synthetic' || value.evidenceStatus === 'simulated')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceStatus'],
      message: 'funded modes cannot report synthetic or simulated PnL evidence'
    });
  }
});

export const ModeSeparatedPnlSnapshotV2Schema = z.object({
  schemaVersion: z.literal(2),
  asOf: z.string().datetime({ offset: true }),
  modes: ModePnlBucketV2Schema.array()
}).strict().superRefine((value, context) => {
  const seen = new Set<RunModeV2>();
  for (const [index, entry] of value.modes.entries()) {
    if (seen.has(entry.mode)) {
      context.addIssue({
        code: 'custom',
        path: ['modes', index, 'mode'],
        message: `duplicate PnL mode ${entry.mode}`
      });
    }
    seen.add(entry.mode);
  }
});

export const ProfessionalRuntimeStatusV2Schema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().min(1),
  configSnapshotId: z.string().min(1),
  runtimeMode: RunModeV2Schema,
  ledgerReconciliationStatus: z.enum(['matched', 'pending', 'mismatch', 'degraded', 'unknown']),
  riskMode: z.enum([
    'healthy',
    'warning',
    'flatten_only',
    'reconcile_required',
    'manual_hold',
    'unknown'
  ]),
  dailyPnlMode: RunModeV2Schema,
  dailyPnlSol: z.number().finite().nullable(),
  drawdownPct: z.number().finite().nonnegative().nullable(),
  outboxPending: z.number().int().nonnegative(),
  sourceQuality: SourceQualityV2Schema,
  datasetVersion: z.string().min(1),
  researchDataStatus: z.enum(['valid', 'observing', 'invalid', 'degraded', 'unknown']),
  modePnl: ModeSeparatedPnlSnapshotV2Schema,
  updatedAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, context) => {
  if (value.dailyPnlMode !== value.runtimeMode) {
    context.addIssue({
      code: 'custom',
      path: ['dailyPnlMode'],
      message: 'daily PnL must be qualified by the active runtime mode'
    });
  }
  const activeBucket = value.modePnl.modes.find((entry) => entry.mode === value.runtimeMode);
  const expected = activeBucket?.netPnlSol ?? null;
  if (!Object.is(value.dailyPnlSol, expected)) {
    context.addIssue({
      code: 'custom',
      path: ['dailyPnlSol'],
      message: 'daily PnL cannot be borrowed or combined across modes'
    });
  }
});

export type ModePnlBucketV2 = z.infer<typeof ModePnlBucketV2Schema>;
export type ModeSeparatedPnlSnapshotV2 = z.infer<typeof ModeSeparatedPnlSnapshotV2Schema>;
export type ProfessionalRuntimeStatusV2 = z.infer<typeof ProfessionalRuntimeStatusV2Schema>;

const MODE_ORDER: RunModeV2[] = ['mechanical-soak', 'economic-shadow', 'canary', 'live'];
const EVIDENCE_SEVERITY: Record<ModePnlBucketV2['evidenceStatus'], number> = {
  exact: 0,
  partial: 1,
  simulated: 1,
  synthetic: 1,
  untrusted: 2
};

function sumNullable(values: Array<number | null>): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function buildModeSeparatedPnlSnapshotV2(
  rawBuckets: z.input<typeof ModePnlBucketV2Schema>[],
  asOf = new Date().toISOString()
): ModeSeparatedPnlSnapshotV2 {
  const buckets = rawBuckets.map((bucket) => ModePnlBucketV2Schema.parse(
    bucket.mode === 'mechanical-soak'
      ? {
          ...bucket,
          grossPnlSol: null,
          netPnlSol: null,
          realizedPnlSol: null,
          unrealizedPnlSol: null
        }
      : bucket
  ));
  const modes = MODE_ORDER.flatMap((mode) => {
    const selected = buckets.filter((bucket) => bucket.mode === mode);
    if (selected.length === 0) return [];
    const evidenceStatus = selected
      .map((bucket) => bucket.evidenceStatus)
      .reduce((worst, current) => (
        EVIDENCE_SEVERITY[current] > EVIDENCE_SEVERITY[worst] ? current : worst
      ));
    return [ModePnlBucketV2Schema.parse({
      mode,
      grossPnlSol: mode === 'mechanical-soak' ? null : sumNullable(selected.map((bucket) => bucket.grossPnlSol)),
      netPnlSol: mode === 'mechanical-soak' ? null : sumNullable(selected.map((bucket) => bucket.netPnlSol)),
      realizedPnlSol: mode === 'mechanical-soak' ? null : sumNullable(selected.map((bucket) => bucket.realizedPnlSol)),
      unrealizedPnlSol: mode === 'mechanical-soak' ? null : sumNullable(selected.map((bucket) => bucket.unrealizedPnlSol)),
      finalizedEpisodeCount: selected.reduce((sum, bucket) => sum + bucket.finalizedEpisodeCount, 0),
      evidenceStatus
    })];
  });

  return ModeSeparatedPnlSnapshotV2Schema.parse({ schemaVersion: 2, asOf, modes });
}

export function buildProfessionalRuntimeStatusV2(input: {
  runId: string;
  configSnapshotId: string;
  runtimeMode: RunModeV2;
  ledgerReconciliationStatus: ProfessionalRuntimeStatusV2['ledgerReconciliationStatus'];
  riskMode: ProfessionalRuntimeStatusV2['riskMode'];
  drawdownPct: number | null;
  outboxPending: number;
  sourceQuality: ProfessionalRuntimeStatusV2['sourceQuality'];
  datasetVersion: string;
  researchDataStatus: ProfessionalRuntimeStatusV2['researchDataStatus'];
  modePnl: ModeSeparatedPnlSnapshotV2;
  updatedAt?: string;
}): ProfessionalRuntimeStatusV2 {
  const activePnl = input.modePnl.modes.find((entry) => entry.mode === input.runtimeMode)?.netPnlSol ?? null;
  return ProfessionalRuntimeStatusV2Schema.parse({
    schemaVersion: 2,
    ...input,
    dailyPnlMode: input.runtimeMode,
    dailyPnlSol: activePnl,
    updatedAt: input.updatedAt ?? new Date().toISOString()
  });
}

export class ProfessionalRuntimeStatusV2Store {
  readonly path: string;

  constructor(stateRootDir: string) {
    this.path = join(stateRootDir, 'professional-runtime-status-v2.json');
  }

  read(): Promise<ProfessionalRuntimeStatusV2 | null> {
    return readJsonIfExists(this.path, ProfessionalRuntimeStatusV2Schema);
  }

  async write(status: ProfessionalRuntimeStatusV2): Promise<ProfessionalRuntimeStatusV2> {
    const parsed = ProfessionalRuntimeStatusV2Schema.parse(status);
    await writeJsonAtomically(this.path, parsed);
    return parsed;
  }
}

function isPendingOutbox(record: DurableOutboxRecordV2) {
  return record.status !== 'finalized' && record.status !== 'failed_terminal';
}

function pnlEvidenceFor(mode: RunModeV2, risk: RiskStateV2): ModePnlBucketV2['evidenceStatus'] {
  if (mode === 'mechanical-soak') return 'synthetic';
  if (mode === 'economic-shadow') return 'simulated';
  return risk.dataQualityStatus === 'untrusted' || risk.reconciliationStatus === 'mismatch'
    ? 'untrusted'
    : 'partial';
}

function sourceQualityFor(risk: RiskStateV2 | null, outboxPending: number): ProfessionalRuntimeStatusV2['sourceQuality'] {
  if (!risk) return 'unknown';
  if (
    risk.dataQualityStatus === 'untrusted'
    || risk.reconciliationStatus === 'mismatch'
    || risk.outboxStatus === 'unknown'
    || risk.valuationStatus === 'unavailable'
  ) return 'unavailable';
  if (
    risk.dataQualityStatus === 'degraded'
    || risk.reconciliationStatus === 'pending'
    || risk.outboxStatus === 'pending'
    || risk.valuationStatus === 'degraded'
    || outboxPending > 0
  ) return 'partial';
  return 'healthy';
}

async function readLatestRunManifest(stateRootDir: string): Promise<RunManifestV2 | null> {
  const root = join(stateRootDir, 'run-manifests');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const manifests = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const raw = await readFile(join(root, entry.name, 'run-manifest.json'), 'utf8');
          return RunManifestV2Schema.parse(JSON.parse(raw));
        } catch {
          return null;
        }
      }));
    return manifests
      .filter((manifest): manifest is RunManifestV2 => manifest !== null)
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0] ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function deriveProfessionalRuntimeStatusV2(input: {
  stateRootDir: string;
  strategyId: 'new-token-v1' | 'large-pool-v1';
  now?: string;
}): Promise<ProfessionalRuntimeStatusV2 | null> {
  const store = new ProfessionalRuntimeStatusV2Store(input.stateRootDir);
  const [persisted, manifest] = await Promise.all([
    store.read(),
    readLatestRunManifest(input.stateRootDir)
  ]);
  if (!manifest) return null;
  if (
    persisted
    && persisted.runId === manifest.runId
    && persisted.configSnapshotId === manifest.effectiveConfigSha256
  ) return persisted;

  const [risk, outbox, datasetStatus] = await Promise.all([
    new RiskStateV2Store(input.stateRootDir).read(),
    new DurableTransactionOutboxV2(input.stateRootDir).read(),
    readJsonIfExists(
      resolveEvolutionPaths(input.strategyId, join(input.stateRootDir, 'evolution')).datasetStatusPath,
      DatasetStatusV1Schema
    )
  ]);
  const outboxPending = outbox.filter(isPendingOutbox).length;
  const now = input.now ?? new Date().toISOString();
  const modePnl = buildModeSeparatedPnlSnapshotV2(risk ? [{
    mode: manifest.mode,
    grossPnlSol: null,
    netPnlSol: risk.dailyNetPnlSol,
    realizedPnlSol: risk.realizedPnlSol,
    unrealizedPnlSol: risk.unrealizedPnlSol,
    finalizedEpisodeCount: 0,
    evidenceStatus: pnlEvidenceFor(manifest.mode, risk)
  }] : [], now);

  return buildProfessionalRuntimeStatusV2({
    runId: manifest.runId,
    configSnapshotId: manifest.effectiveConfigSha256,
    runtimeMode: manifest.mode,
    ledgerReconciliationStatus: risk?.reconciliationStatus ?? 'unknown',
    riskMode: risk?.riskMode ?? 'unknown',
    drawdownPct: risk?.drawdownPct ?? null,
    outboxPending,
    sourceQuality: sourceQualityFor(risk, outboxPending),
    datasetVersion: manifest.datasetVersion,
    researchDataStatus: datasetStatus?.researchStatus === 'invalid' ? 'invalid' : 'observing',
    modePnl,
    updatedAt: now
  });
}
