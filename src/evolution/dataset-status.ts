import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { stableStringify } from '../shared/canonical-json.ts';
import { resolveEvolutionPaths } from './paths.ts';
import { EvolutionStrategyIdSchema, type EvolutionStrategyId } from './types.ts';

const DatasetArtifactKindSchema = z.enum([
  'candidate_scans',
  'pool_decision_samples',
  'watchlist_snapshots',
  'position_outcomes',
  'paper_ledger',
  'evidence_snapshot',
  'report_json',
  'report_markdown',
  'proposal_catalog',
  'approval_queue',
  'approval_history',
  'outcome_ledger'
]);

export const DatasetStatusV1Schema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.literal('research_invalid_v1'),
  strategyId: EvolutionStrategyIdSchema,
  researchStatus: z.literal('invalid'),
  immutable: z.literal(true),
  sealedAt: z.string().datetime(),
  allowedUses: z.tuple([z.literal('forensics'), z.literal('operations')]),
  forbiddenUses: z.tuple([
    z.literal('parameter_selection'),
    z.literal('pnl_claim'),
    z.literal('training'),
    z.literal('statistical_validation')
  ]),
  artifacts: z.array(z.object({
    kind: DatasetArtifactKindSchema,
    path: z.string().min(1),
    present: z.boolean(),
    byteSize: z.number().int().nonnegative().nullable()
  }).strict())
}).strict();

export type DatasetStatusV1 = z.infer<typeof DatasetStatusV1Schema>;

export class DatasetStatusStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<DatasetStatusV1 | null> {
    try {
      return DatasetStatusV1Schema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  async seal(input: DatasetStatusV1): Promise<DatasetStatusV1> {
    const status = DatasetStatusV1Schema.parse(input);
    await mkdir(dirname(this.path), { recursive: true });

    try {
      await writeFile(this.path, `${JSON.stringify(status, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return status;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    const existing = await this.read();
    if (existing && stableStringify(existing) === stableStringify(status)) {
      return existing;
    }

    throw new Error(`Dataset status is immutable and already sealed at ${this.path}`);
  }
}

export async function buildLegacyDatasetStatus(input: {
  strategyId: EvolutionStrategyId;
  stateRootDir: string;
  evolutionRootDir?: string;
  sealedAt?: string;
}): Promise<DatasetStatusV1> {
  const paths = resolveEvolutionPaths(
    input.strategyId,
    input.evolutionRootDir ?? join(input.stateRootDir, 'evolution')
  );
  const artifactPaths: Array<{
    kind: z.infer<typeof DatasetArtifactKindSchema>;
    path: string;
  }> = [
    { kind: 'candidate_scans', path: paths.candidateScansPath },
    { kind: 'pool_decision_samples', path: paths.poolDecisionSamplesPath },
    { kind: 'watchlist_snapshots', path: paths.watchlistSnapshotsPath },
    { kind: 'position_outcomes', path: paths.positionOutcomesPath },
    { kind: 'paper_ledger', path: join(input.stateRootDir, 'paper-dry-run-state.json') },
    { kind: 'paper_ledger', path: join(input.stateRootDir, 'solana-execution', 'paper-dry-run-state.json') },
    { kind: 'evidence_snapshot', path: paths.evidenceSnapshotPath },
    { kind: 'report_json', path: paths.reportJsonPath },
    { kind: 'report_markdown', path: paths.reportMarkdownPath },
    { kind: 'proposal_catalog', path: paths.proposalCatalogPath },
    { kind: 'approval_queue', path: paths.approvalQueuePath },
    { kind: 'approval_history', path: paths.approvalHistoryPath },
    { kind: 'outcome_ledger', path: paths.outcomeLedgerPath }
  ];

  const artifacts = await Promise.all(artifactPaths.map(async (artifact) => {
    try {
      const metadata = await stat(artifact.path);
      return {
        ...artifact,
        present: metadata.isFile(),
        byteSize: metadata.isFile() ? metadata.size : null
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...artifact, present: false, byteSize: null };
      }

      throw error;
    }
  }));

  return DatasetStatusV1Schema.parse({
    schemaVersion: 1,
    datasetId: 'research_invalid_v1',
    strategyId: input.strategyId,
    researchStatus: 'invalid',
    immutable: true,
    sealedAt: input.sealedAt ?? new Date().toISOString(),
    allowedUses: ['forensics', 'operations'],
    forbiddenUses: ['parameter_selection', 'pnl_claim', 'training', 'statistical_validation'],
    artifacts
  });
}

export async function quarantineLegacyEvolutionDataset(input: {
  strategyId: EvolutionStrategyId;
  stateRootDir: string;
  evolutionRootDir?: string;
  sealedAt?: string;
}) {
  const paths = resolveEvolutionPaths(
    input.strategyId,
    input.evolutionRootDir ?? join(input.stateRootDir, 'evolution')
  );
  const store = new DatasetStatusStore(paths.datasetStatusPath);
  const existing = await store.read();
  if (existing) {
    return {
      statusPath: paths.datasetStatusPath,
      status: existing
    };
  }

  const status = await buildLegacyDatasetStatus(input);
  await store.seal(status);

  return {
    statusPath: paths.datasetStatusPath,
    status
  };
}

export class LegacyDatasetRejectedError extends Error {
  readonly code = 'LEGACY_DATASET_REJECTED';

  constructor() {
    super(
      'V1 evolution evidence is quarantined as research_invalid_v1. '
      + 'Use --forensics-allow-v1 for read-only diagnostics; V1 data can never produce proposals.'
    );
    this.name = 'LegacyDatasetRejectedError';
  }
}
