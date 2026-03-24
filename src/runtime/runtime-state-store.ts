import { join } from 'node:path';

import {
  DependencyHealthSnapshotSchema,
  type DependencyHealthSnapshot,
  HealthReportSchema,
  type HealthReport,
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

  async writeHealthReport(snapshot: HealthReport) {
    await writeJsonAtomically(join(this.rootDir, 'health.json'), HealthReportSchema.parse(snapshot));
  }

  async readHealthReport(): Promise<HealthReport | null> {
    return readJsonIfExists(join(this.rootDir, 'health.json'), HealthReportSchema);
  }
}
