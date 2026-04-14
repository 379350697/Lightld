import { MirrorBuffer } from './mirror-buffer.ts';
import { type MirrorConfig } from './mirror-config.ts';
import type { MirrorEvent, MirrorEventSink } from './mirror-events.ts';
import {
  type MirrorMetricsSnapshot,
  createMirrorMetricsSnapshot
} from './mirror-types.ts';
import { SqliteMirrorWriter } from './sqlite-mirror-writer.ts';

type MirrorWriter = {
  open(): Promise<void>;
  close(): Promise<void>;
  writeBatch(events: MirrorEvent[]): Promise<void>;
};

type CreateMirrorRuntimeOptions = {
  config: MirrorConfig;
  writer?: MirrorWriter;
};

export type MirrorRuntime = MirrorEventSink & {
  start(): Promise<void>;
  stop(): Promise<void>;
  flushOnce(): Promise<boolean>;
  snapshot(): MirrorMetricsSnapshot;
};

export function createMirrorRuntime(options: CreateMirrorRuntimeOptions): MirrorRuntime {
  const writer = options.writer ?? new SqliteMirrorWriter({ path: options.config.path });
  const buffer = new MirrorBuffer({ capacity: options.config.queueCapacity });
  let metrics = createMirrorMetricsSnapshot({
    enabled: options.config.enabled,
    path: options.config.path,
    queueCapacity: options.config.queueCapacity
  });
  let opened = false;
  let timer: NodeJS.Timeout | undefined;
  let flushing = false;

  async function ensureOpened() {
    if (!options.config.enabled || opened) {
      return;
    }

    await writer.open();
    opened = true;
  }

  function updateMetrics(partial: Partial<MirrorMetricsSnapshot>) {
    const bufferSnapshot = buffer.snapshot();

    metrics = {
      ...metrics,
      ...partial,
      queueDepth: bufferSnapshot.queueDepth,
      droppedEvents: bufferSnapshot.droppedEvents,
      droppedLowPriority: bufferSnapshot.droppedLowPriority
    };
  }

  async function flushOnce() {
    if (!options.config.enabled || flushing) {
      return false;
    }

    const now = new Date();

    if (metrics.state === 'open' && metrics.cooldownUntil !== '' && metrics.cooldownUntil > now.toISOString()) {
      updateMetrics({});
      return false;
    }

    const batch = buffer.peek(options.config.batchSize);

    if (batch.length === 0) {
      updateMetrics({});
      return false;
    }

    flushing = true;

    try {
      await ensureOpened();
      const startedAtMs = Date.now();
      let attempt = 0;
      let lastError: Error | undefined;

      while (attempt <= options.config.maxRetries) {
        try {
          await writer.writeBatch(batch);
          buffer.ack(batch.length);
          updateMetrics({
            state: buffer.snapshot().droppedEvents > 0 ? 'degraded' : 'healthy',
            consecutiveFailures: 0,
            lastFlushAt: new Date().toISOString(),
            lastFlushLatencyMs: Date.now() - startedAtMs,
            cooldownUntil: '',
            lastError: ''
          });
          return true;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          attempt += 1;
        }
      }

      const consecutiveFailures = metrics.consecutiveFailures + 1;
      const shouldOpen = consecutiveFailures >= options.config.failureThreshold;

      updateMetrics({
        state: shouldOpen ? 'open' : 'degraded',
        consecutiveFailures,
        cooldownUntil: shouldOpen
          ? new Date(now.getTime() + options.config.cooldownMs).toISOString()
          : metrics.cooldownUntil,
        lastError: lastError?.message ?? 'mirror-write-failed'
      });

      return false;
    } finally {
      flushing = false;
    }
  }

  return {
    enqueue(event: MirrorEvent) {
      buffer.enqueue(event);
      updateMetrics({});
    },
    async start() {
      if (!options.config.enabled || timer) {
        return;
      }

      await ensureOpened();
      timer = setInterval(() => {
        void flushOnce();
      }, options.config.flushIntervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }

      if (options.config.enabled && metrics.state !== 'open') {
        await flushOnce();
      }

      if (opened) {
        await writer.close();
        opened = false;
      }
    },
    flushOnce,
    snapshot() {
      updateMetrics({});
      return metrics;
    }
  };
}
