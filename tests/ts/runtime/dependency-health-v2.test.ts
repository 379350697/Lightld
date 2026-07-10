import { describe, expect, it } from 'vitest';

import {
  DEPENDENCY_KEYS_V2,
  buildDependencyHealthSnapshotV2,
  buildDiskWalHealthObservationV2,
  type DependencyHealthObservationV2
} from '../../../src/runtime/dependency-health-v2';

const observedAt = '2026-07-10T04:00:00.000Z';

function healthyDependencies(): Record<(typeof DEPENDENCY_KEYS_V2)[number], DependencyHealthObservationV2> {
  return Object.fromEntries(DEPENDENCY_KEYS_V2.map((key) => [key, {
    status: 'healthy',
    observedAt,
    consecutiveFailures: 0,
    reason: ''
  }])) as Record<(typeof DEPENDENCY_KEYS_V2)[number], DependencyHealthObservationV2>;
}

describe('DependencyHealthSnapshotV2', () => {
  it('requires every production dependency and reports a healthy open/exit path', () => {
    const snapshot = buildDependencyHealthSnapshotV2({
      runId: 'run-1',
      configSnapshotId: 'config-1',
      mode: 'canary',
      observedAt,
      dependencies: healthyDependencies()
    });

    expect(Object.keys(snapshot.dependencies)).toEqual(DEPENDENCY_KEYS_V2);
    expect(snapshot.overallStatus).toBe('healthy');
    expect(snapshot.allowNewOpens).toBe(true);
    expect(snapshot.allowRiskReduction).toBe(true);
  });

  it('fails new opens closed on stale safety while preserving the independent exit path', () => {
    const dependencies = healthyDependencies();
    dependencies.gmgnSafety = {
      status: 'stale',
      observedAt,
      consecutiveFailures: 1,
      reason: 'safety-cache-too-old'
    };

    const snapshot = buildDependencyHealthSnapshotV2({
      runId: 'run-2',
      configSnapshotId: 'config-2',
      mode: 'live',
      observedAt,
      dependencies
    });

    expect(snapshot.overallStatus).toBe('stale');
    expect(snapshot.allowNewOpens).toBe(false);
    expect(snapshot.allowRiskReduction).toBe(true);
    expect(snapshot.blockingNewOpenDependencies).toEqual(['gmgnSafety']);
  });

  it('marks risk reduction unavailable when the sell route is down', () => {
    const dependencies = healthyDependencies();
    dependencies.sellRoute = {
      status: 'unavailable',
      observedAt,
      consecutiveFailures: 3,
      reason: 'no-exit-route'
    };

    const snapshot = buildDependencyHealthSnapshotV2({
      runId: 'run-3',
      configSnapshotId: 'config-3',
      mode: 'canary',
      observedAt,
      dependencies
    });

    expect(snapshot.allowNewOpens).toBe(false);
    expect(snapshot.allowRiskReduction).toBe(false);
    expect(snapshot.blockingRiskReductionDependencies).toContain('sellRoute');
  });

  it('turns disk usage thresholds into disk/WAL health gates', () => {
    expect(buildDiskWalHealthObservationV2({
      observedAt,
      totalBytes: 100,
      availableBytes: 31
    })).toMatchObject({
      status: 'healthy',
      reason: 'disk-usage-ok'
    });

    const warning = buildDiskWalHealthObservationV2({
      observedAt,
      totalBytes: 100,
      availableBytes: 30
    });
    const halt = buildDiskWalHealthObservationV2({
      observedAt,
      totalBytes: 100,
      availableBytes: 15
    });
    const dependencies = healthyDependencies();
    dependencies.diskWal = halt;

    expect(warning).toMatchObject({
      status: 'degraded',
      reason: 'disk-usage-warning-threshold',
      threshold: 0.70
    });
    expect(halt).toMatchObject({
      status: 'unavailable',
      reason: 'disk-usage-halt-threshold',
      threshold: 0.85
    });
    expect(buildDependencyHealthSnapshotV2({
      runId: 'run-disk',
      configSnapshotId: 'config-disk',
      mode: 'live',
      observedAt,
      dependencies
    })).toMatchObject({
      allowNewOpens: false,
      blockingNewOpenDependencies: ['diskWal']
    });
  });

  it('rejects incomplete snapshots instead of silently treating missing sources as healthy', () => {
    const dependencies = healthyDependencies();
    delete (dependencies as Partial<typeof dependencies>).finality;

    expect(() => buildDependencyHealthSnapshotV2({
      runId: 'run-4',
      configSnapshotId: 'config-4',
      mode: 'canary',
      observedAt,
      dependencies
    })).toThrow();
  });
});
