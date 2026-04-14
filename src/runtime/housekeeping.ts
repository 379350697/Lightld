import { join } from 'node:path';

import { cleanupRotatedJsonlFiles } from '../journals/jsonl-writer.ts';
import type { StrategyId } from './live-cycle.ts';
import type { HousekeepingSnapshot } from './state-types.ts';

type CacheSweepResult = {
  expiredDeleted: number;
  evictedDeleted: number;
  remainingEntries: number;
};

type CreateHousekeepingRunnerOptions = {
  intervalMs: number;
  runJournalCleanup?: () => Promise<number>;
  runMirrorPrune?: () => Promise<number>;
  runGmgnCacheSweep?: () => CacheSweepResult | Promise<CacheSweepResult>;
};

export type HousekeepingRunner = {
  runIfDue(now?: Date): Promise<HousekeepingSnapshot>;
  snapshot(): HousekeepingSnapshot;
};

export type JournalRetentionDays = {
  decisionAudit: number;
  quotes: number;
  orders: number;
  fills: number;
  incidents: number;
};

export const DEFAULT_JOURNAL_RETENTION_DAYS: JournalRetentionDays = {
  decisionAudit: 14,
  quotes: 7,
  orders: 90,
  fills: 90,
  incidents: 30
};

function createEmptySnapshot(): HousekeepingSnapshot {
  return {
    lastHousekeepingAt: '',
    journalCleanupDeletedFiles: 0,
    mirrorPruneDeletedRows: 0,
    gmgnSafetyCacheEntries: 0,
    lastCleanupError: ''
  };
}

export function createHousekeepingRunner(
  options: CreateHousekeepingRunnerOptions
): HousekeepingRunner {
  let lastRunAtMs = 0;
  let snapshot = createEmptySnapshot();

  return {
    async runIfDue(now = new Date()) {
      const nowMs = now.getTime();

      if (lastRunAtMs > 0 && nowMs - lastRunAtMs < options.intervalMs) {
        return snapshot;
      }

      let journalCleanupDeletedFiles = snapshot.journalCleanupDeletedFiles;
      let mirrorPruneDeletedRows = snapshot.mirrorPruneDeletedRows;
      let gmgnSafetyCacheEntries = snapshot.gmgnSafetyCacheEntries;
      let lastCleanupError = '';

      try {
        journalCleanupDeletedFiles = options.runJournalCleanup
          ? await options.runJournalCleanup()
          : 0;
        mirrorPruneDeletedRows = options.runMirrorPrune
          ? await options.runMirrorPrune()
          : 0;

        if (options.runGmgnCacheSweep) {
          gmgnSafetyCacheEntries = (await options.runGmgnCacheSweep()).remainingEntries;
        }
      } catch (error) {
        lastCleanupError = error instanceof Error ? error.message : String(error);
      }

      lastRunAtMs = nowMs;
      snapshot = {
        lastHousekeepingAt: now.toISOString(),
        journalCleanupDeletedFiles,
        mirrorPruneDeletedRows,
        gmgnSafetyCacheEntries,
        lastCleanupError
      };

      return snapshot;
    },
    snapshot() {
      return snapshot;
    }
  };
}

export async function cleanupRuntimeJournals(input: {
  strategy: StrategyId;
  journalRootDir: string;
  retentionDays?: Partial<JournalRetentionDays>;
  now?: Date;
}) {
  const retentionDays = {
    ...DEFAULT_JOURNAL_RETENTION_DAYS,
    ...input.retentionDays
  };
  const now = input.now ?? new Date();
  const baseName = input.strategy;

  const deleted = await Promise.all([
    cleanupRotatedJsonlFiles(join(input.journalRootDir, `${baseName}-decision-audit.jsonl`), {
      retentionDays: retentionDays.decisionAudit,
      now
    }),
    cleanupRotatedJsonlFiles(join(input.journalRootDir, `${baseName}-quotes.jsonl`), {
      retentionDays: retentionDays.quotes,
      now
    }),
    cleanupRotatedJsonlFiles(join(input.journalRootDir, `${baseName}-live-orders.jsonl`), {
      retentionDays: retentionDays.orders,
      now
    }),
    cleanupRotatedJsonlFiles(join(input.journalRootDir, `${baseName}-live-fills.jsonl`), {
      retentionDays: retentionDays.fills,
      now
    }),
    cleanupRotatedJsonlFiles(join(input.journalRootDir, `${baseName}-live-incidents.jsonl`), {
      retentionDays: retentionDays.incidents,
      now
    })
  ]);

  return deleted.reduce((sum, count) => sum + count, 0);
}
