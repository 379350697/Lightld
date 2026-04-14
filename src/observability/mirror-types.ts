import { z } from 'zod';

export const MirrorHealthStateSchema = z.enum(['healthy', 'degraded', 'open']);
export type MirrorHealthState = z.infer<typeof MirrorHealthStateSchema>;

export const MirrorEventPrioritySchema = z.enum(['high', 'medium', 'low']);
export type MirrorEventPriority = z.infer<typeof MirrorEventPrioritySchema>;

export const MirrorMetricsSnapshotSchema = z.object({
  enabled: z.boolean(),
  state: MirrorHealthStateSchema,
  path: z.string(),
  queueDepth: z.number().int().nonnegative(),
  queueCapacity: z.number().int().positive(),
  droppedEvents: z.number().int().nonnegative(),
  droppedLowPriority: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastFlushAt: z.string(),
  lastFlushLatencyMs: z.number().int().nonnegative(),
  cooldownUntil: z.string(),
  lastError: z.string()
});

export type MirrorMetricsSnapshot = z.infer<typeof MirrorMetricsSnapshotSchema>;

export function createMirrorMetricsSnapshot(input: {
  enabled: boolean;
  path: string;
  state?: MirrorHealthState;
  queueCapacity?: number;
}): MirrorMetricsSnapshot {
  return {
    enabled: input.enabled,
    state: input.state ?? 'healthy',
    path: input.path,
    queueDepth: 0,
    queueCapacity: input.queueCapacity ?? 1000,
    droppedEvents: 0,
    droppedLowPriority: 0,
    consecutiveFailures: 0,
    lastFlushAt: '',
    lastFlushLatencyMs: 0,
    cooldownUntil: '',
    lastError: ''
  };
}
