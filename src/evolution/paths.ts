import { join } from 'node:path/posix';

import type { EvolutionStrategyId } from './types.ts';

export type EvolutionPaths = {
  rootDir: string;
  candidateScansPath: string;
  watchlistSnapshotsPath: string;
  watchlistTrackedTokensPath: string;
  positionOutcomesPath: string;
  evidenceSnapshotPath: string;
  reportJsonPath: string;
  reportMarkdownPath: string;
  proposalCatalogPath: string;
  approvalQueuePath: string;
  approvalHistoryPath: string;
  outcomeLedgerPath: string;
  patchDraftsDir: string;
  approvedPatchesDir: string;
};

export function resolveEvolutionPaths(
  strategyId: EvolutionStrategyId,
  baseRootDir = join('state', 'evolution')
): EvolutionPaths {
  const rootDir = join(baseRootDir, strategyId);

  return {
    rootDir,
    candidateScansPath: join(rootDir, 'candidate-scans.jsonl'),
    watchlistSnapshotsPath: join(rootDir, 'watchlist-snapshots.jsonl'),
    watchlistTrackedTokensPath: join(rootDir, 'watchlist-tracked-tokens.json'),
    positionOutcomesPath: join(rootDir, 'position-outcomes.jsonl'),
    evidenceSnapshotPath: join(rootDir, 'evidence-snapshot.json'),
    reportJsonPath: join(rootDir, 'evolution-report.json'),
    reportMarkdownPath: join(rootDir, 'evolution-report.md'),
    proposalCatalogPath: join(rootDir, 'proposal-catalog.json'),
    approvalQueuePath: join(rootDir, 'approval-queue.json'),
    approvalHistoryPath: join(rootDir, 'approval-history.jsonl'),
    outcomeLedgerPath: join(rootDir, 'outcome-ledger.jsonl'),
    patchDraftsDir: join(rootDir, 'patch-drafts'),
    approvedPatchesDir: join(rootDir, 'approved-patches')
  };
}
