import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { readJsonLines } from '../journals/jsonl-writer.ts';
import {
  CandidateScanRecordArraySchema,
  CandidateScanRecordSchema,
  type CandidateScanRecord,
  LiveCycleOutcomeRecordArraySchema,
  LiveCycleOutcomeRecordSchema,
  type LiveCycleOutcomeRecord,
  WatchlistSnapshotRecordArraySchema,
  WatchlistSnapshotRecordSchema,
  type WatchlistSnapshotRecord
} from './types.ts';
import { resolveEvolutionPaths } from './paths.ts';

export type EvolutionEvidence = {
  candidateScans: CandidateScanRecord[];
  watchlistSnapshots: WatchlistSnapshotRecord[];
  outcomes: LiveCycleOutcomeRecord[];
};

type LoadEvolutionEvidenceInput = {
  strategyId: 'new-token-v1' | 'large-pool-v1';
  stateRootDir?: string;
  mirrorPath?: string;
};

export async function loadEvolutionEvidence(input: LoadEvolutionEvidenceInput): Promise<EvolutionEvidence> {
  const stateRootDir = input.stateRootDir ?? 'state';
  const paths = resolveEvolutionPaths(input.strategyId, join(stateRootDir, 'evolution'));
  const mirroredCandidateScans = await readMirroredRows(
    input.mirrorPath,
    'candidate_scans',
    CandidateScanRecordSchema
  );
  const mirroredWatchlistSnapshots = await readMirroredRows(
    input.mirrorPath,
    'watchlist_snapshots',
    WatchlistSnapshotRecordSchema
  );
  const candidateScans = mirroredCandidateScans
    ?? CandidateScanRecordArraySchema.parse(await readJsonLines<CandidateScanRecord>(paths.candidateScansPath));
  const watchlistSnapshots = mirroredWatchlistSnapshots
    ?? WatchlistSnapshotRecordArraySchema.parse(
      await readJsonLines<WatchlistSnapshotRecord>(paths.watchlistSnapshotsPath)
    );
  const outcomes = LiveCycleOutcomeRecordArraySchema.parse(
    await readJsonLines<LiveCycleOutcomeRecord>(paths.positionOutcomesPath)
  );

  return {
    candidateScans,
    watchlistSnapshots,
    outcomes
  };
}

async function readMirroredRows<T>(
  mirrorPath: string | undefined,
  tableName: 'candidate_scans' | 'watchlist_snapshots',
  schema: {
    parse(value: unknown): T;
  }
): Promise<T[] | null> {
  if (!mirrorPath || !(await fileExists(mirrorPath))) {
    return null;
  }

  const database = new DatabaseSync(mirrorPath, { readOnly: true });

  try {
    const rows = database.prepare(`
      SELECT raw_json AS rawJson
      FROM ${tableName}
      ORDER BY ${tableName === 'candidate_scans' ? 'captured_at' : 'observation_at'} DESC
    `).all() as Array<{ rawJson: string }>;

    return rows.map((row) => schema.parse(JSON.parse(row.rawJson)));
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }

    throw error;
  } finally {
    database.close();
  }
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isMissingTableError(error: unknown) {
  return error instanceof Error && error.message.includes('no such table');
}
