import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type SlidingWindowRateLimiter = {
  waitForSlot(): Promise<void>;
};

type RateLimiterOptions = {
  capacity: number;
  windowMs: number;
  nowMs?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

type FileBackedRateLimiterOptions = RateLimiterOptions & {
  statePath: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
};

type RateLimitState = {
  timestamps: number[];
};

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function normalizeCapacity(value: number) {
  return Math.max(1, Math.floor(value));
}

function normalizeWindowMs(value: number) {
  return Math.max(1, Math.floor(value));
}

function pruneTimestamps(timestamps: number[], windowStart: number) {
  return timestamps
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > windowStart)
    .sort((left, right) => left - right);
}

export class InMemorySlidingWindowRateLimiter implements SlidingWindowRateLimiter {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly nowMs: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly timestamps: number[] = [];

  constructor(options: RateLimiterOptions) {
    this.capacity = normalizeCapacity(options.capacity);
    this.windowMs = normalizeWindowMs(options.windowMs);
    this.nowMs = options.nowMs ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  async waitForSlot() {
    while (true) {
      const now = this.nowMs();
      const windowStart = now - this.windowMs;
      const pruned = pruneTimestamps(this.timestamps, windowStart);
      this.timestamps.splice(0, this.timestamps.length, ...pruned);

      if (this.timestamps.length < this.capacity) {
        this.timestamps.push(now);
        return;
      }

      await this.sleep(Math.max(1, this.timestamps[0] + this.windowMs - now));
    }
  }
}

export class FileBackedSlidingWindowRateLimiter implements SlidingWindowRateLimiter {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly nowMs: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;

  constructor(options: FileBackedRateLimiterOptions) {
    this.statePath = options.statePath;
    this.lockPath = `${options.statePath}.lock`;
    this.capacity = normalizeCapacity(options.capacity);
    this.windowMs = normalizeWindowMs(options.windowMs);
    this.nowMs = options.nowMs ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.lockTimeoutMs = Math.max(1_000, options.lockTimeoutMs ?? 10_000);
    this.lockRetryMs = Math.max(5, options.lockRetryMs ?? 25);
  }

  async waitForSlot() {
    while (true) {
      let waitMs = 0;

      await this.withLock(async () => {
        const now = this.nowMs();
        const state = await this.readState();
        const timestamps = pruneTimestamps(state.timestamps, now - this.windowMs);

        if (timestamps.length < this.capacity) {
          timestamps.push(now);
          await this.writeState({ timestamps });
          waitMs = 0;
          return;
        }

        await this.writeState({ timestamps });
        waitMs = Math.max(1, timestamps[0] + this.windowMs - now);
      });

      if (waitMs <= 0) {
        return;
      }

      await this.sleep(waitMs);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.lockPath), { recursive: true });

    while (true) {
      try {
        await mkdir(this.lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }

        await this.removeStaleLock();
        await this.sleep(this.lockRetryMs);
      }
    }

    try {
      return await operation();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async removeStaleLock() {
    try {
      const lockStat = await stat(this.lockPath);
      if (this.nowMs() - lockStat.mtimeMs > this.lockTimeoutMs) {
        await rm(this.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async readState(): Promise<RateLimitState> {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RateLimitState>;
      return {
        timestamps: Array.isArray(parsed.timestamps) ? parsed.timestamps : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
        return { timestamps: [] };
      }

      throw error;
    }
  }

  private async writeState(state: RateLimitState) {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state)}\n`, 'utf8');
  }
}
