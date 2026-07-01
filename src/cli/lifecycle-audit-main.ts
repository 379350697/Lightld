import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PendingSubmissionStore } from '../runtime/pending-submission-store.ts';
import { RuntimeStateStore } from '../runtime/runtime-state-store.ts';
import type { PendingSubmissionSnapshot, PositionLedgerRecord, PositionLedgerSnapshot } from '../runtime/state-types.ts';

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

type CrossTargetIdentityIssue = { kind: 'cross-target-identity'; field: 'openIntentId' | 'positionId'; value: string; targets: string[] };
type StaleOpenPendingIssue = { kind: 'stale-open-pending'; positionKey: string; poolAddress?: string; tokenMint?: string; reason?: string };
type LifecycleIssue = CrossTargetIdentityIssue | StaleOpenPendingIssue;

function findCrossTargetIdentityIssues(ledger: PositionLedgerSnapshot | null): CrossTargetIdentityIssue[] {
  const issues: CrossTargetIdentityIssue[] = [];
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
        issues.push({ kind: 'cross-target-identity', field, value, targets: [...targets].sort() });
      }
    }
  }

  return issues;
}

function pendingMatchesRecord(pending: PendingSubmissionSnapshot | null, record: PositionLedgerRecord) {
  return Boolean(
    pending
    && pending.orderAction === 'add-lp'
    && (
      (pending.openIntentId && pending.openIntentId === record.openIntentId)
      || (
        pending.poolAddress === record.activePoolAddress
        && pending.tokenMint === record.activeMint
      )
    )
  );
}

function findStaleOpenPendingIssues(
  ledger: PositionLedgerSnapshot | null,
  pending: PendingSubmissionSnapshot | null
): StaleOpenPendingIssue[] {
  return (ledger?.records ?? [])
    .filter((record) =>
      record.lifecycleState === 'open_pending'
      && !record.chainPositionAddress
      && !pendingMatchesRecord(pending, record)
      && (
        Boolean(record.missingOnChainSince)
        || record.lastReason === 'http-400'
        || record.lastReason === 'sign-failed'
        || record.lastReason === 'not-submitted'
        || record.lastReason === 'broadcast-not-submitted'
        || record.lastReason === 'chain-position-missing-without-exit-evidence'
      )
    )
    .map((record) => ({
      kind: 'stale-open-pending' as const,
      positionKey: record.positionKey,
      poolAddress: record.activePoolAddress,
      tokenMint: record.activeMint,
      reason: record.lastReason
    }));
}

function findLifecycleIssues(
  ledger: PositionLedgerSnapshot | null,
  pending: PendingSubmissionSnapshot | null
): LifecycleIssue[] {
  return [
    ...findCrossTargetIdentityIssues(ledger),
    ...findStaleOpenPendingIssues(ledger, pending)
  ];
}

function repairLedger(ledger: PositionLedgerSnapshot, pending: PendingSubmissionSnapshot | null, now: string) {
  const issues = findLifecycleIssues(ledger, pending);
  if (issues.length === 0) {
    return { ledger, changed: false, issues };
  }

  const duplicatedOpenIntentIds = new Set(
    issues
      .filter((issue): issue is CrossTargetIdentityIssue => issue.kind === 'cross-target-identity' && issue.field === 'openIntentId')
      .map((issue) => issue.value)
  );
  const duplicatedPositionIds = new Set(
    issues
      .filter((issue): issue is CrossTargetIdentityIssue => issue.kind === 'cross-target-identity' && issue.field === 'positionId')
      .map((issue) => issue.value)
  );
  const staleOpenPendingKeys = new Set(
    issues
      .filter((issue): issue is StaleOpenPendingIssue => issue.kind === 'stale-open-pending')
      .map((issue) => issue.positionKey)
  );

  return {
    changed: true,
    issues,
    ledger: {
      version: 1 as const,
      updatedAt: now,
      records: ledger.records.map((record) => {
        if (staleOpenPendingKeys.has(record.positionKey)) {
          const isTerminalFailedAttempt = record.lastReason === 'http-400'
            || record.lastReason === 'sign-failed'
            || record.lastReason === 'not-submitted'
            || record.lastReason === 'broadcast-not-submitted'
            || record.lastReason === 'chain-position-missing-without-exit-evidence'
            || Boolean(record.missingOnChainSince);
          return {
            ...record,
            lifecycleState: isTerminalFailedAttempt ? 'failed_terminal' as const : 'reconcile_required' as const,
            importStatus: 'archived_missing_without_exit_evidence' as const,
            lastReason: isTerminalFailedAttempt
              ? record.lastReason
              : 'open-pending-without-chain-evidence-repaired',
            missingOnChainSince: record.missingOnChainSince ?? now,
            lastClosedAt: isTerminalFailedAttempt ? record.lastClosedAt ?? now : record.lastClosedAt,
            updatedAt: now
          };
        }

        return {
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
        };
      })
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
  const pendingStore = new PendingSubmissionStore(args.stateRootDir);
  const ledger = await store.readPositionLedger();
  const pending = await pendingStore.read();
  const issues = findLifecycleIssues(ledger, pending);
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
  await copyIfExists(join(args.stateRootDir, 'order-attempt-ledger.json'), join(args.backupDir, 'order-attempt-ledger.json'));
  const repaired = repairLedger(ledger, pending, new Date().toISOString());
  await store.writePositionLedger(repaired.ledger);
  const positionState = await store.readPositionState();
  const closedActiveRecord = repaired.ledger.records.find((record) =>
    (record.lifecycleState === 'failed_terminal' || record.lifecycleState === 'reconcile_required')
    && (record.lastReason === 'open-pending-without-chain-evidence-repaired' || record.lastReason === 'http-400')
    && positionState?.activePoolAddress === record.activePoolAddress
    && positionState?.activeMint === record.activeMint
  );
  if (positionState && closedActiveRecord) {
    await store.writePositionState({
      ...positionState,
      openIntentId: undefined,
      positionId: undefined,
      chainPositionAddress: undefined,
      activeMint: undefined,
      activePoolAddress: undefined,
      lifecycleState: 'closed',
      lastReason: 'open-pending-without-chain-evidence-repaired',
      lastClosedMint: positionState.activeMint ?? positionState.lastClosedMint,
      lastClosedAt: closedActiveRecord.lastClosedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
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
