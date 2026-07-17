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
  lastResetDate: z.string().min(1),
  reservations: z.array(z.object({
    idempotencyKey: z.string().min(1),
    requestedSol: z.number().finite().nonnegative(),
    settledSol: z.number().finite().nonnegative().optional(),
    status: z.enum(['reserved', 'settled']),
    reservedAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1)
  })).default([])
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
  return resetDateStringAt(new Date(), resetHour);
}

function resetDateStringAt(date: Date, resetHour: number) {
  const adjusted = new Date(date.getTime() - resetHour * 60 * 60 * 1000);
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
    lastHourlyResetAt: state.lastHourlyResetAt ?? currentHourString(),
    reservations: state.reservations ?? []
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
      lastResetDate: today,
      reservations: []
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
    lastResetDate: todayDateString(resetHour),
    reservations: []
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
      lastResetDate: current.lastResetDate,
      reservations: current.reservations
    };

    await writeJsonAtomically(this.path, SpendingLimitsStateSchema.parse(updated));
    return updated;
  }

  async reserveSpend(idempotencyKey: string, requestedSol: number): Promise<SpendingLimitsState> {
    if (!Number.isFinite(requestedSol) || requestedSol < 0) {
      throw new Error(`invalid-spend-reservation:${idempotencyKey}`);
    }

    const current = await this.read();
    const existing = current.reservations.find((reservation) => reservation.idempotencyKey === idempotencyKey);

    if (existing) {
      if (existing.requestedSol !== requestedSol) {
        throw new Error(`spending-reservation-conflict:${idempotencyKey}`);
      }
      return current;
    }

    const reservedAt = new Date().toISOString();
    const updated: SpendingLimitsState = {
      dailySpendSol: current.dailySpendSol + requestedSol,
      hourlySpendSol: current.hourlySpendSol + requestedSol,
      orderCount: current.orderCount + 1,
      hourlyOrderCount: current.hourlyOrderCount + 1,
      lastHourlyResetAt: current.lastHourlyResetAt,
      lastResetDate: current.lastResetDate,
      reservations: [
        ...current.reservations,
        {
          idempotencyKey,
          requestedSol,
          status: 'reserved',
          reservedAt,
          updatedAt: reservedAt
        }
      ]
    };

    await writeJsonAtomically(this.path, SpendingLimitsStateSchema.parse(updated));
    return updated;
  }

  /**
   * Releases only an un-settled reservation. Missing and already-settled
   * reservations are intentional no-ops so callers can safely retry cleanup
   * after a definite pre-submission failure.
   */
  async releaseSpend(
    idempotencyKey: string,
    expectedRequestedSol?: number
  ): Promise<SpendingLimitsState> {
    const current = await this.read();
    const existingIndex = current.reservations.findIndex(
      (reservation) => reservation.idempotencyKey === idempotencyKey
    );

    if (
      existingIndex < 0
      || current.reservations[existingIndex].status === 'settled'
      || (
        expectedRequestedSol !== undefined
        && current.reservations[existingIndex].requestedSol !== expectedRequestedSol
      )
    ) {
      return current;
    }

    const existing = current.reservations[existingIndex];
    const reservations = current.reservations.filter((_, index) => index !== existingIndex);
    const reservedAt = existing.reservedAt ?? existing.updatedAt;
    const countsTowardCurrentDay = resetDateStringAt(new Date(reservedAt), this.resetHour)
      === current.lastResetDate;
    const countsTowardCurrentHour = reservedAt.slice(0, 13) === current.lastHourlyResetAt;
    const updated: SpendingLimitsState = {
      dailySpendSol: countsTowardCurrentDay
        ? Math.max(0, current.dailySpendSol - existing.requestedSol)
        : current.dailySpendSol,
      hourlySpendSol: countsTowardCurrentHour
        ? Math.max(0, current.hourlySpendSol - existing.requestedSol)
        : current.hourlySpendSol,
      orderCount: countsTowardCurrentDay
        ? Math.max(0, current.orderCount - 1)
        : current.orderCount,
      hourlyOrderCount: countsTowardCurrentHour
        ? Math.max(0, current.hourlyOrderCount - 1)
        : current.hourlyOrderCount,
      lastHourlyResetAt: current.lastHourlyResetAt,
      lastResetDate: current.lastResetDate,
      reservations
    };

    await writeJsonAtomically(this.path, SpendingLimitsStateSchema.parse(updated));
    return updated;
  }

  async settleSpend(idempotencyKey: string, actualSol: number): Promise<SpendingLimitsState> {
    const current = await this.read();
    const existingIndex = current.reservations.findIndex((reservation) => reservation.idempotencyKey === idempotencyKey);

    if (existingIndex < 0 || !Number.isFinite(actualSol) || actualSol <= 0) {
      return current;
    }

    const existing = current.reservations[existingIndex];
    if (existing.status === 'settled' && existing.settledSol === actualSol) {
      return current;
    }

    const previousBookedSol = existing.status === 'settled' && typeof existing.settledSol === 'number'
      ? existing.settledSol
      : existing.requestedSol;
    const deltaSol = actualSol - previousBookedSol;
    const reservedAt = existing.reservedAt ?? existing.updatedAt;
    const countsTowardCurrentDay = resetDateStringAt(new Date(reservedAt), this.resetHour)
      === current.lastResetDate;
    const countsTowardCurrentHour = reservedAt.slice(0, 13) === current.lastHourlyResetAt;
    const reservations = [...current.reservations];
    reservations[existingIndex] = {
      ...existing,
      reservedAt,
      settledSol: actualSol,
      status: 'settled',
      updatedAt: new Date().toISOString()
    };
    const updated: SpendingLimitsState = {
      dailySpendSol: countsTowardCurrentDay
        ? Math.max(0, current.dailySpendSol + deltaSol)
        : current.dailySpendSol,
      hourlySpendSol: countsTowardCurrentHour
        ? Math.max(0, current.hourlySpendSol + deltaSol)
        : current.hourlySpendSol,
      orderCount: current.orderCount,
      hourlyOrderCount: current.hourlyOrderCount,
      lastHourlyResetAt: current.lastHourlyResetAt,
      lastResetDate: current.lastResetDate,
      reservations
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
