import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from '../runtime/atomic-file.ts';
import { join } from 'node:path';

export type SpendingLimitsConfig = {
  maxSingleOrderSol: number;
  maxDailySpendSol: number;
  dailySpendResetHour?: number;
};

const SpendingLimitsStateSchema = z.object({
  dailySpendSol: z.number().finite().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  lastResetDate: z.string().min(1)
});

export type SpendingLimitsState = z.infer<typeof SpendingLimitsStateSchema>;

export type SpendingLimitsResult =
  | { allowed: true; reason: 'spending-allowed' }
  | {
      allowed: false;
      reason: 'single-order-limit-exceeded' | 'daily-spend-limit-exceeded';
      detail: string;
    };

function todayDateString(resetHour: number) {
  const now = new Date();
  const adjusted = new Date(now.getTime() - resetHour * 60 * 60 * 1000);
  return adjusted.toISOString().slice(0, 10);
}

function ensureResetIfNewDay(state: SpendingLimitsState, resetHour: number): SpendingLimitsState {
  const today = todayDateString(resetHour);

  if (state.lastResetDate !== today) {
    return {
      dailySpendSol: 0,
      orderCount: 0,
      lastResetDate: today
    };
  }

  return state;
}

export function createEmptySpendingLimitsState(resetHour = 0): SpendingLimitsState {
  return {
    dailySpendSol: 0,
    orderCount: 0,
    lastResetDate: todayDateString(resetHour)
  };
}

export function evaluateSpendingLimits(
  config: SpendingLimitsConfig,
  rawState: SpendingLimitsState,
  requestedSol: number
): SpendingLimitsResult {
  const state = ensureResetIfNewDay(rawState, config.dailySpendResetHour ?? 0);

  if (requestedSol > config.maxSingleOrderSol) {
    return {
      allowed: false,
      reason: 'single-order-limit-exceeded',
      detail: `requested ${requestedSol} SOL exceeds single-order limit of ${config.maxSingleOrderSol} SOL`
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

    return ensureResetIfNewDay(stored, this.resetHour);
  }

  async recordSpend(spentSol: number): Promise<SpendingLimitsState> {
    const current = await this.read();
    const updated: SpendingLimitsState = {
      dailySpendSol: current.dailySpendSol + spentSol,
      orderCount: current.orderCount + 1,
      lastResetDate: current.lastResetDate
    };

    await writeJsonAtomically(this.path, SpendingLimitsStateSchema.parse(updated));
    return updated;
  }
}
