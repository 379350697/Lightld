import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { RuntimeStateStore } from '../runtime/runtime-state-store.ts';
import type { PositionLedgerRecord, PositionLedgerSnapshot } from '../runtime/state-types.ts';

type Args = {
  stateRootDir: string;
  apply: boolean;
  backupDir: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    stateRootDir: process.env.LIVE_STATE_DIR ?? join('state', process.env.LIVE_STRATEGY_ID ?? 'new-token-v1'),
    apply: false,
    backupDir: join('tmp', 'lifecycle-repair-backups', new Date().toISOString().replace(/[:.]/g, '-'))
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--state-root-dir' && next) {
      args.stateRootDir = next;
      index += 1;
      continue;
    }

    if (current === '--backup-dir' && next) {
      args.backupDir = next;
      index += 1;
      continue;
    }

    if (current === '--apply') {
      args.apply = true;
    }
  }

  return args;
}

function targetKey(record: PositionLedgerRecord) {
  return `${record.chainPositionAddress ?? ''}|${record.activePoolAddress ?? ''}|${record.activeMint ?? ''}`;
}

function findCrossTargetIdentityIssues(ledger: PositionLedgerSnapshot | null) {
  const issues: Array<{ field: 'openIntentId' | 'positionId'; value: string; targets: string[] }> = [];
  const records = ledger?.records ?? [];

  for (const field of ['openIntentId', 'positionId'] as const) {
    const grouped = new Map<string, Set<string>>();
    for (const record of records) {
      const value = record[field];
      if (!value) {
        continue;
      }

      if (!grouped.has(value)) {
        grouped.set(value, new Set());
      }
      grouped.get(value)!.add(targetKey(record));
    }

    for (const [value, targets] of grouped.entries()) {
      if (targets.size > 1) {
        issues.push({ field, value, targets: [...targets].sort() });
      }
    }
  }

  return issues;
}

function repairLedger(ledger: PositionLedgerSnapshot, now: string) {
  const issues = findCrossTargetIdentityIssues(ledger);
  if (issues.length === 0) {
    return { ledger, changed: false, issues };
  }

  const duplicatedOpenIntentIds = new Set(
    issues.filter((issue) => issue.field === 'openIntentId').map((issue) => issue.value)
  );
  const duplicatedPositionIds = new Set(
    issues.filter((issue) => issue.field === 'positionId').map((issue) => issue.value)
  );

  return {
    changed: true,
    issues,
    ledger: {
      version: 1 as const,
      updatedAt: now,
      records: ledger.records.map((record) => ({
        ...record,
        openIntentId: record.openIntentId && duplicatedOpenIntentIds.has(record.openIntentId)
          ? undefined
          : record.openIntentId,
        positionId: record.positionId && duplicatedPositionIds.has(record.positionId) && record.chainPositionAddress
          ? record.chainPositionAddress
          : record.positionId,
        importStatus: record.importStatus === 'imported' && (
          (record.openIntentId && duplicatedOpenIntentIds.has(record.openIntentId))
          || (record.positionId && duplicatedPositionIds.has(record.positionId))
        )
          ? 'entry_unknown' as const
          : record.importStatus,
        valuationStatus: record.openIntentId && duplicatedOpenIntentIds.has(record.openIntentId)
          ? 'unavailable' as const
          : record.valuationStatus,
        valuationReason: record.openIntentId && duplicatedOpenIntentIds.has(record.openIntentId)
          ? 'lifecycle-identity-cross-target-repaired'
          : record.valuationReason,
        updatedAt: now
      }))
    }
  };
}

async function copyIfExists(source: string, target: string) {
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } catch {
    return;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new RuntimeStateStore(args.stateRootDir);
  const ledger = await store.readPositionLedger();
  const issues = findCrossTargetIdentityIssues(ledger);
  const report = {
    stateRootDir: args.stateRootDir,
    apply: args.apply,
    issues,
    issueCount: issues.length
  };

  if (!args.apply || !ledger || issues.length === 0) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  await copyIfExists(join(args.stateRootDir, 'position-ledger.json'), join(args.backupDir, 'position-ledger.json'));
  await copyIfExists(join(args.stateRootDir, 'position-state.json'), join(args.backupDir, 'position-state.json'));
  const repaired = repairLedger(ledger, new Date().toISOString());
  await store.writePositionLedger(repaired.ledger);
  try {
    JSON.parse(await readFile(join(args.stateRootDir, 'position-state.json'), 'utf8'));
  } catch {
    // Missing compatibility state is repaired by the daemon on next tick.
  }

  process.stdout.write(`${JSON.stringify({
    ...report,
    changed: repaired.changed,
    backupDir: args.backupDir
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
