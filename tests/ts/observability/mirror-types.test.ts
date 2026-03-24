import { describe, expect, it } from 'vitest';

import {
  MirrorMetricsSnapshotSchema,
  createMirrorMetricsSnapshot
} from '../../../src/observability/mirror-types';

describe('createMirrorMetricsSnapshot', () => {
  it('creates a valid default metrics snapshot', () => {
    const snapshot = createMirrorMetricsSnapshot({
      enabled: true,
      path: '/tmp/lightld.sqlite'
    });

    expect(MirrorMetricsSnapshotSchema.parse(snapshot)).toMatchObject({
      enabled: true,
      state: 'healthy',
      queueDepth: 0,
      droppedEvents: 0,
      path: '/tmp/lightld.sqlite'
    });
  });
});
