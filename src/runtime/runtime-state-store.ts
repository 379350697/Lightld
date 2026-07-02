import { join } from 'node:path';

import {
  DependencyHealthSnapshotSchema,
  type DependencyHealthSnapshot,
  HealthReportSchema,
  type HealthReport,
  LifecycleEventLogSnapshotSchema,
  LifecycleEventRecordSchema,
  type LifecycleEventLogSnapshot,
  type LifecycleEventRecord,
  OrderAttemptLedgerSnapshotSchema,
  OrderAttemptRecordSchema,
  type OrderAttemptLedgerSnapshot,
  type OrderAttemptRecord,
  PositionLedgerRecordSchema,
  PositionLedgerSnapshotSchema,
  type PositionLedgerRecord,
  type PositionLedgerSnapshot,
  PositionStateSnapshotSchema,
  type PositionStateSnapshot,
  RuntimeStateSnapshotSchema,
  type RuntimeStateSnapshot
} from './state-types.ts';
import { readJsonIfExists, writeJsonAtomically } from './atomic-file.ts';

export class RuntimeStateStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async writeRuntimeState(snapshot: RuntimeStateSnapshot) {
    await writeJsonAtomically(join(this.rootDir, 'runtime-state.json'), RuntimeStateSnapshotSchema.parse(snapshot));
  }

  async readRuntimeState(): Promise<RuntimeStateSnapshot | null> {
    return readJsonIfExists(join(this.rootDir, 'runtime-state.json'), RuntimeStateSnapshotSchema);
  }

  async writeDependencyHealth(snapshot: DependencyHealthSnapshot) {
    await writeJsonAtomically(
      join(this.rootDir, 'dependency-health.json'),
      DependencyHealthSnapshotSchema.parse(snapshot)
    );
  }

  async readDependencyHealth(): Promise<DependencyHealthSnapshot | null> {
    return readJsonIfExists(
      join(this.rootDir, 'dependency-health.json'),
      DependencyHealthSnapshotSchema
    );
  }

  async writePositionState(snapshot: PositionStateSnapshot) {
    await writeJsonAtomically(
      join(this.rootDir, 'position-state.json'),
      PositionStateSnapshotSchema.parse(snapshot)
    );
  }

  async readPositionState(): Promise<PositionStateSnapshot | null> {
    return readJsonIfExists(join(this.rootDir, 'position-state.json'), PositionStateSnapshotSchema);
  }

  async writePositionLedger(snapshot: PositionLedgerSnapshot) {
    await writeJsonAtomically(
      join(this.rootDir, 'position-ledger.json'),
      PositionLedgerSnapshotSchema.parse(snapshot)
    );
  }

  async readPositionLedger(): Promise<PositionLedgerSnapshot | null> {
    return readJsonIfExists(join(this.rootDir, 'position-ledger.json'), PositionLedgerSnapshotSchema);
  }

  async upsertPositionRecord(record: PositionLedgerRecord) {
    const current = await this.readPositionLedger();
    const parsedRecord = PositionLedgerRecordSchema.parse(record);
    const records = current?.records ?? [];
    const index = records.findIndex((item) => item.positionKey === parsedRecord.positionKey);
    const nextRecords = index >= 0
      ? records.map((item, itemIndex) => itemIndex === index ? parsedRecord : item)
      : [...records, parsedRecord];

    await this.writePositionLedger({
      version: 1,
      records: nextRecords,
      updatedAt: parsedRecord.updatedAt
    });
  }

  async writeOrderAttemptLedger(snapshot: OrderAttemptLedgerSnapshot) {
    await writeJsonAtomically(
      join(this.rootDir, 'order-attempt-ledger.json'),
      OrderAttemptLedgerSnapshotSchema.parse(snapshot)
    );
  }

  async readOrderAttemptLedger(): Promise<OrderAttemptLedgerSnapshot | null> {
    return readJsonIfExists(join(this.rootDir, 'order-attempt-ledger.json'), OrderAttemptLedgerSnapshotSchema);
  }

  async writeLifecycleEventLog(snapshot: LifecycleEventLogSnapshot) {
    await writeJsonAtomically(
      join(this.rootDir, 'lifecycle-events.json'),
      LifecycleEventLogSnapshotSchema.parse(snapshot)
    );
  }

  async readLifecycleEventLog(): Promise<LifecycleEventLogSnapshot | null> {
    return readJsonIfExists(join(this.rootDir, 'lifecycle-events.json'), LifecycleEventLogSnapshotSchema);
  }

  async appendLifecycleEvents(events: LifecycleEventRecord[]) {
    if (events.length === 0) {
      return;
    }

    const current = await this.readLifecycleEventLog();
    const byKey = new Map<string, LifecycleEventRecord>();
    for (const event of current?.events ?? []) {
      byKey.set(event.eventKey, event);
    }
    for (const event of events) {
      const parsed = LifecycleEventRecordSchema.parse(event);
      byKey.set(parsed.eventKey, parsed);
    }
    const nextEvents = [...byKey.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventKey.localeCompare(right.eventKey));
    await this.writeLifecycleEventLog({
      version: 1,
      events: nextEvents,
      updatedAt: nextEvents[nextEvents.length - 1]?.createdAt ?? new Date().toISOString()
    });
  }

  async upsertOrderAttempt(record: OrderAttemptRecord) {
    const current = await this.readOrderAttemptLedger();
    const parsedRecord = OrderAttemptRecordSchema.parse(record);
    const records = current?.records ?? [];
    const index = records.findIndex((item) => item.attemptKey === parsedRecord.attemptKey);
    const nextRecords = index >= 0
      ? records.map((item, itemIndex) => itemIndex === index
        ? {
            ...item,
            ...parsedRecord,
            createdAt: item.createdAt
          }
        : item)
      : [...records, parsedRecord];

    await this.writeOrderAttemptLedger({
      version: 1,
      records: nextRecords,
      updatedAt: parsedRecord.updatedAt
    });
  }

  async writeHealthReport(snapshot: HealthReport) {
    await writeJsonAtomically(join(this.rootDir, 'health.json'), HealthReportSchema.parse(snapshot));
  }

  async readHealthReport(): Promise<HealthReport | null> {
    return readJsonIfExists(join(this.rootDir, 'health.json'), HealthReportSchema);
  }
}
