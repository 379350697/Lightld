import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type IncidentDedupeDecision =
  | {
      append: true;
      duplicateCount: number;
      firstSeenAt: string;
      lastSeenAt: string;
    }
  | {
      append: false;
    };

type IncidentDedupeState = {
  firstSeenAt: number;
  lastSeenAt: number;
  duplicateCount: number;
};

type IncidentDedupeOptions = {
  ttlMs?: number;
  nowMs?: () => number;
  statePath?: string;
};

const DEFAULT_TTL_MS = 10 * 60_000;

function toIso(timestampMs: number) {
  return new Date(timestampMs).toISOString();
}

export class IncidentDedupeStore {
  private readonly states = new Map<string, IncidentDedupeState>();
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private statePath?: string;
  private loaded = false;

  constructor(options: IncidentDedupeOptions = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
    this.nowMs = options.nowMs ?? Date.now;
    this.statePath = options.statePath;
  }

  configurePersistence(statePath: string) {
    if (this.statePath === statePath) {
      return;
    }

    this.statePath = statePath;
    this.loaded = false;
    this.states.clear();
  }

  async shouldAppend(key: string, options: { ttlMs?: number } = {}): Promise<IncidentDedupeDecision> {
    await this.load();
    const now = this.nowMs();
    const ttlMs = Math.max(0, options.ttlMs ?? this.ttlMs);
    const existing = this.states.get(key);

    if (!existing) {
      this.states.set(key, {
        firstSeenAt: now,
        lastSeenAt: now,
        duplicateCount: 0
      });
      await this.persist();
      return {
        append: true,
        duplicateCount: 0,
        firstSeenAt: toIso(now),
        lastSeenAt: toIso(now)
      };
    }

    if (ttlMs > 0 && now - existing.lastSeenAt < ttlMs) {
      existing.duplicateCount += 1;
      existing.lastSeenAt = now;
      await this.persist();
      return { append: false };
    }

    const duplicateCount = existing.duplicateCount;
    const firstSeenAt = existing.firstSeenAt;
    existing.firstSeenAt = now;
    existing.lastSeenAt = now;
    existing.duplicateCount = 0;
    await this.persist();

    return {
      append: true,
      duplicateCount,
      firstSeenAt: toIso(firstSeenAt),
      lastSeenAt: toIso(now)
    };
  }

  reset() {
    this.states.clear();
    this.loaded = true;
  }

  private async load() {
    if (this.loaded || !this.statePath) {
      this.loaded = true;
      return;
    }

    try {
      const raw = await readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, IncidentDedupeState>;
      this.states.clear();
      for (const [key, value] of Object.entries(parsed)) {
        if (
          Number.isFinite(value.firstSeenAt) &&
          Number.isFinite(value.lastSeenAt) &&
          Number.isFinite(value.duplicateCount)
        ) {
          this.states.set(key, {
            firstSeenAt: value.firstSeenAt,
            lastSeenAt: value.lastSeenAt,
            duplicateCount: value.duplicateCount
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }

    this.loaded = true;
  }

  private async persist() {
    if (!this.statePath) {
      return;
    }

    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(Object.fromEntries(this.states))}\n`, 'utf8');
  }
}

export const liveIncidentDedupeStore = new IncidentDedupeStore();
