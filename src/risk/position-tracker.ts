import { z } from 'zod';
import { readJsonIfExists, writeJsonAtomically } from '../runtime/atomic-file.ts';

export type PositionEntry = {
  tokenMint: string;
  tokenSymbol: string;
  entrySol: number;
  entryTime: string;
  poolAddress: string;
  /** Position type: 'swap' (default) or 'lp' for DLMM LP positions */
  positionType?: 'swap' | 'lp';
  /** LP: accumulated fees earned in SOL */
  lpFeesAccumulatedSol?: number;
  /** LP: current position value in SOL */
  lpCurrentValueSol?: number;
  /** LP: range lower bound as downside coverage percentage */
  lpRangeLowerPct?: number;
};

export type PositionTrackerState = {
  positions: PositionEntry[];
  updatedAt: string;
};

const PositionEntrySchema = z.object({
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  entrySol: z.number(),
  entryTime: z.string(),
  poolAddress: z.string(),
  positionType: z.enum(['swap', 'lp']).optional(),
  lpFeesAccumulatedSol: z.number().optional(),
  lpCurrentValueSol: z.number().optional(),
  lpRangeLowerPct: z.number().optional()
});

const PositionTrackerStateSchema = z.object({
  positions: z.array(PositionEntrySchema),
  updatedAt: z.string()
});

export type StopLossConfig = {
  maxLossPct: number;
  takeProfitPct: number;
};

export type PnlCheckResult = {
  action: 'force-sell' | 'hold';
  reason: string;
  unrealizedPct: number;
};

const EMPTY_STATE: PositionTrackerState = {
  positions: [],
  updatedAt: new Date(0).toISOString()
};

export async function readPositionTracker(
  filePath: string
): Promise<PositionTrackerState> {
  const raw = await readJsonIfExists<PositionTrackerState>(filePath, PositionTrackerStateSchema);
  return raw ?? EMPTY_STATE;
}

export async function recordPositionEntry(
  filePath: string,
  entry: PositionEntry
): Promise<void> {
  const state = await readPositionTracker(filePath);
  const existing = state.positions.findIndex(
    (position) => position.tokenMint === entry.tokenMint
  );

  if (existing >= 0) {
    state.positions[existing] = entry;
  } else {
    state.positions.push(entry);
  }

  state.updatedAt = new Date().toISOString();
  await writeJsonAtomically(filePath, state);
}

export async function removePosition(
  filePath: string,
  tokenMint: string
): Promise<void> {
  const state = await readPositionTracker(filePath);
  state.positions = state.positions.filter(
    (position) => position.tokenMint !== tokenMint
  );
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomically(filePath, state);
}

export function evaluateStopLoss(
  entrySol: number,
  currentValueSol: number,
  config: StopLossConfig
): PnlCheckResult {
  if (entrySol <= 0) {
    return { action: 'hold', reason: 'no-entry-value', unrealizedPct: 0 };
  }

  const unrealizedPct = ((currentValueSol - entrySol) / entrySol) * 100;

  if (unrealizedPct <= -config.maxLossPct) {
    return {
      action: 'force-sell',
      reason: `stop-loss-triggered (${unrealizedPct.toFixed(1)}%)`,
      unrealizedPct
    };
  }

  if (unrealizedPct >= config.takeProfitPct) {
    return {
      action: 'force-sell',
      reason: `take-profit-triggered (${unrealizedPct.toFixed(1)}%)`,
      unrealizedPct
    };
  }

  return { action: 'hold', reason: 'within-thresholds', unrealizedPct };
}

export type LpPnlConfig = {
  stopLossNetPnlPct: number;
  takeProfitNetPnlPct: number;
};

/**
 * Evaluate LP position net PnL including accumulated fees.
 * netPnlPct = (currentValueSol + accumulatedFeesSol - entrySol) / entrySol * 100
 */
export function evaluateLpPnl(
  entrySol: number,
  currentValueSol: number,
  accumulatedFeesSol: number,
  config: LpPnlConfig
): PnlCheckResult {
  if (entrySol <= 0) {
    return { action: 'hold', reason: 'no-entry-value', unrealizedPct: 0 };
  }

  const netPnlPct =
    ((currentValueSol + accumulatedFeesSol - entrySol) / entrySol) * 100;

  if (netPnlPct <= -config.stopLossNetPnlPct) {
    return {
      action: 'force-sell',
      reason: `lp-stop-loss (${netPnlPct.toFixed(1)}%)`,
      unrealizedPct: netPnlPct
    };
  }

  if (netPnlPct >= config.takeProfitNetPnlPct) {
    return {
      action: 'force-sell',
      reason: `lp-take-profit (${netPnlPct.toFixed(1)}%)`,
      unrealizedPct: netPnlPct
    };
  }

  return { action: 'hold', reason: 'within-lp-thresholds', unrealizedPct: netPnlPct };
}
