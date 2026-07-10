import { join } from 'node:path';

import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from '../runtime/atomic-file.ts';

const ExposureMapSchema = z.record(z.string(), z.number().finite().nonnegative());

export const RiskStateV2Schema = z.object({
  schemaVersion: z.literal(2),
  riskSnapshotId: z.string().min(1),
  asOf: z.iso.datetime({ offset: true }),
  tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  riskMode: z.enum([
    'healthy',
    'warning',
    'flatten_only',
    'reconcile_required',
    'manual_hold'
  ]),
  startOfDayEquitySol: z.number().finite().nonnegative(),
  currentEquitySol: z.number().finite().nonnegative(),
  highWaterEquitySol: z.number().finite().nonnegative(),
  realizedPnlSol: z.number().finite(),
  unrealizedPnlSol: z.number().finite(),
  dailyNetPnlSol: z.number().finite(),
  drawdownPct: z.number().finite().nonnegative(),
  grossExposureSol: z.number().finite().nonnegative(),
  netExposureSol: z.number().finite(),
  exposureByMintSol: ExposureMapSchema,
  exposureByPoolSol: ExposureMapSchema,
  exposureByDeployerSol: ExposureMapSchema,
  consecutiveLosses: z.number().int().nonnegative(),
  activePositionCount: z.number().int().nonnegative(),
  dailyNewRiskSol: z.number().finite().nonnegative(),
  availableSol: z.number().finite().nonnegative(),
  dataQualityStatus: z.enum(['trusted', 'degraded', 'untrusted']),
  reconciliationStatus: z.enum(['matched', 'pending', 'mismatch']),
  outboxStatus: z.enum(['settled', 'pending', 'unknown']),
  valuationStatus: z.enum(['ready', 'degraded', 'unavailable']),
  allowNewOpens: z.boolean(),
  allowRiskIncrease: z.boolean(),
  allowRiskReduction: z.literal(true),
  flattenOnly: z.boolean(),
  autoFlattenRequired: z.boolean(),
  manualRecoveryRequired: z.boolean(),
  triggerReasons: z.array(z.string().min(1)),
  recoveryApprovedBy: z.string().min(1).optional(),
  recoveryApprovedAt: z.iso.datetime({ offset: true }).optional()
});

export type RiskStateV2 = z.infer<typeof RiskStateV2Schema>;

export class RiskStateV2Store {
  private readonly path: string;

  constructor(stateRootDir: string, fileName = 'risk-state-v2.json') {
    this.path = join(stateRootDir, fileName);
  }

  async read(): Promise<RiskStateV2 | null> {
    return readJsonIfExists(this.path, RiskStateV2Schema);
  }

  async write(state: RiskStateV2): Promise<RiskStateV2> {
    const validated = RiskStateV2Schema.parse(state);
    await writeJsonAtomically(this.path, validated);
    return validated;
  }

  async update(transform: (current: RiskStateV2 | null) => RiskStateV2): Promise<RiskStateV2> {
    return this.write(transform(await this.read()));
  }
}
