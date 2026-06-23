import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from '../runtime/atomic-file.ts';
import { join } from 'node:path';

export type SpendingLimitsConfig = {
  maxSingleOrderSol: number;
  maxDailySpendSol: number;
  maxHourlySpendSol?: number;
  dailySpendResetHour?: number;
};

const SpendingLimitsStateSchema = z.object({
  dailySpendSol: z.number().finite().nonnegative(),
  hourlySpendSol: z.number().finite().nonnegative().default(0),
  orderCount: z.number().int().nonnegative(),
  hourlyOrderCount: z.number().int().nonnegative().default(0),
  lastHourlyResetAt: z.string().min(1).optional(),
  lastResetDate: z.string().min(1)
});

export type SpendingLimitsState = z.infer<typeof SpendingLimitsStateSchema>;

export type SpendingLimitsResult =
  | { allowed: true; reason: 'spending-allowed' }
  | {
      allowed: false;
      reason: 'single-order-limit-exceeded' | 'hourly-spend-limit-exceeded' | 'daily-spend-limit-exceeded';
      detail: string;
    };

function todayDateString(resetHour: number) {
  const now = new Date();
  const adjusted = new Date(now.getTime() - resetHour * 60 * 60 * 1000);
  return adjusted.toISOString().slice(0, 10);
}

function currentHourString() {
  return new Date().toISOString().slice(0, 13);
}

function normalizeState(state: SpendingLimitsState): SpendingLimitsState {
  return {
    ...state,
    hourlySpendSol: state.hourlySpendSol ?? 0,
    hourlyOrderCount: state.hourlyOrderCount ?? 0,
    lastHourlyResetAt: state.lastHourlyResetAt ?? currentHourString()
  };
}

function ensureResetIfNewDay(state: SpendingLimitsState, resetHour: number): SpendingLimitsState {
  const normalized = normalizeState(state);
  const today = todayDateString(resetHour);

  if (normalized.lastResetDate !== today) {
    return {
      dailySpendSol: 0,
      hourlySpendSol: 0,
      orderCount: 0,
      hourlyOrderCount: 0,
      lastHourlyResetAt: currentHourString(),
      lastResetDate: today
    };
  }

  return normalized;
}

function ensureResetIfNewHour(state: SpendingLimitsState): SpendingLimitsState {
  const normalized = normalizeState(state);
  const currentHour = currentHourString();

  if (normalized.lastHourlyResetAt !== currentHour) {
    return {
      ...normalized,
      hourlySpendSol: 0,
      hourlyOrderCount: 0,
      lastHourlyResetAt: currentHour
    };
  }

  return normalized;
}

function normalizeAndReset(state: SpendingLimitsState, resetHour: number): SpendingLimitsState {
  return ensureResetIfNewHour(ensureResetIfNewDay(state, resetHour));
}

export function createEmptySpendingLimitsState(resetHour = 0): SpendingLimitsState {
  return {
    dailySpendSol: 0,
    hourlySpendSol: 0,
    orderCount: 0,
    hourlyOrderCount: 0,
    lastHourlyResetAt: currentHourString(),
    lastResetDate: todayDateString(resetHour)
  };
}

export function evaluateSpendingLimits(
  config: SpendingLimitsConfig,
  rawState: SpendingLimitsState,
  requestedSol: number
): SpendingLimitsResult {
  const state = normalizeAndReset(rawState, config.dailySpendResetHour ?? 0);

  if (requestedSol > config.maxSingleOrderSol) {
    return {
      allowed: false,
      reason: 'single-order-limit-exceeded',
      detail: `requested ${requestedSol} SOL exceeds single-order limit of ${config.maxSingleOrderSol} SOL`
    };
  }

  if (
    typeof config.maxHourlySpendSol === 'number' &&
    state.hourlySpendSol + requestedSol > config.maxHourlySpendSol
  ) {
    return {
      allowed: false,
      reason: 'hourly-spend-limit-exceeded',
      detail: `hourly spend ${state.hourlySpendSol} + requested ${requestedSol} SOL exceeds hourly limit of ${config.maxHourlySpendSol} SOL`
    };
  }

  if (state.dailySpendSol + requestedSol > config.maxDailySpendSol) {
    return {
      allowed: false,
      reason: 'daily-spend-limit-exceeded',
      detail: `daily spend ${state.dailySpendSol} + requested ${requestedSol} SOL exceeds daily limit of ${config.maxDailySpendSol} SOL`
    };
  }

  return {
    allowed: true,
    reason: 'spending-allowed'
  };
}

export class SpendingLimitsStore {
  private readonly path: string;
  private readonly resetHour: number;

  constructor(stateRootDir: string, resetHour = 0) {
    this.path = join(stateRootDir, 'spending-limits.json');
    this.resetHour = resetHour;
  }

  async read(): Promise<SpendingLimitsState> {
    const stored = await readJsonIfExists(this.path, SpendingLimitsStateSchema);

    if (!stored) {
      return createEmptySpendingLimitsState(this.resetHour);
    }

    return normalizeAndReset(stored, this.resetHour);
  }

  async recordSpend(spentSol: number): Promise<SpendingLimitsState> {
    const current = await this.read();
    const updated: SpendingLimitsState = {
      dailySpendSol: current.dailySpendSol + spentSol,
      hourlySpendSol: current.hourlySpendSol + spentSol,
      orderCount: current.orderCount + 1,
      hourlyOrderCount: current.hourlyOrderCount + 1,
      lastHourlyResetAt: current.lastHourlyResetAt,
      lastResetDate: current.lastResetDate
    };

    await writeJsonAtomically(this.path, SpendingLimitsStateSchema.parse(updated));
    return updated;
  }

  async reset(): Promise<SpendingLimitsState> {
    const reset = createEmptySpendingLimitsState(this.resetHour);
    await writeJsonAtomically(this.path, SpendingLimitsStateSchema.parse(reset));
    return reset;
  }
}
