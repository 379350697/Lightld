import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { z } from 'zod';

import { appendJsonLine, readJsonLines } from '../journals/jsonl-writer.ts';
import { stableStringify } from '../shared/canonical-json.ts';

const RawIntegerStringSchema = z.string().regex(/^-?\d+$/);

export const LedgerEventV2Schema = z.object({
  eventId: z.string().min(1).optional(),
  lifecycleKey: z.string().min(1),
  signature: z.string().min(1),
  instructionIndex: z.number().int().nonnegative(),
  account: z.string().min(1),
  asset: z.string().min(1),
  mint: z.string().min(1),
  slot: z.number().int().nonnegative(),
  blockTime: z.string().min(1),
  finality: z.enum(['confirmed', 'finalized', 'rolled_back']),
  preAmountRaw: RawIntegerStringSchema,
  postAmountRaw: RawIntegerStringSchema,
  baseFeeLamports: RawIntegerStringSchema.default('0'),
  priorityFeeLamports: RawIntegerStringSchema.default('0'),
  jitoTipLamports: RawIntegerStringSchema.default('0'),
  rentLamports: RawIntegerStringSchema.default('0'),
  /** Exact means base/priority/tip/rent were independently attributed. */
  // Legacy/forensic records predate this field; production transaction-meta
  // ingestion always sets it explicitly to partial until fee components are
  // independently attributed.
  feeAttribution: z.enum(['exact', 'partial']).default('exact'),
  failedTransactionCostLamports: RawIntegerStringSchema.default('0'),
  accountChange: z.enum(['unchanged', 'created', 'closed']).default('unchanged'),
  transactionStatus: z.enum(['succeeded', 'failed', 'unknown']).default('unknown'),
  source: z.enum(['transaction-meta', 'chain-reconstruction', 'compensation']),
  compensatesEventId: z.string().min(1).optional()
});

export type LedgerEventV2 = z.infer<typeof LedgerEventV2Schema> & { eventId: string };

function ledgerIdentity(input: Pick<LedgerEventV2, 'signature' | 'instructionIndex' | 'account' | 'asset'>) {
  return `${input.signature}:${input.instructionIndex}:${input.account}:${input.asset}`;
}

function eventIdFor(input: Pick<LedgerEventV2, 'signature' | 'instructionIndex' | 'account' | 'asset'>) {
  return `ledger-v2:${createHash('sha256').update(ledgerIdentity(input)).digest('hex')}`;
}

export class LedgerEventV2Store {
  readonly path: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(stateRootDir: string) {
    this.path = join(stateRootDir, 'ledger-events-v2.jsonl');
  }

  async read(): Promise<LedgerEventV2[]> {
    return (await readJsonLines<unknown>(this.path)).map((entry) => {
      const parsed = LedgerEventV2Schema.parse(entry);
      return { ...parsed, eventId: parsed.eventId ?? eventIdFor(parsed as LedgerEventV2) };
    });
  }

  async append(input: z.input<typeof LedgerEventV2Schema>): Promise<LedgerEventV2> {
    const next = this.operation.then(async () => {
      const parsed = LedgerEventV2Schema.parse(input);
      const event = {
        ...parsed,
        eventId: parsed.eventId ?? eventIdFor(parsed as LedgerEventV2)
      } satisfies LedgerEventV2;
      const existing = (await this.read()).find((candidate) => candidate.eventId === event.eventId);
      if (existing) {
        if (stableStringify(existing) !== stableStringify(event)) {
          throw new Error(`ledger event identity conflict eventId=${event.eventId}`);
        }
        return existing;
      }
      await appendJsonLine(this.path, event);
      return event;
    });
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}

export function buildFinalizedLedgerProjection(events: Array<z.input<typeof LedgerEventV2Schema>>) {
  const balanceDeltaByAsset = new Map<string, bigint>();
  let provisionalEventCount = 0;
  let finalizedEventCount = 0;
  let totalBaseFeeLamports = 0n;
  let totalPriorityFeeLamports = 0n;
  let totalJitoTipLamports = 0n;
  let totalRentLamports = 0n;
  let totalFailedTransactionCostLamports = 0n;

  for (const raw of events) {
    const event = LedgerEventV2Schema.parse(raw);
    if (event.finality !== 'finalized') {
      provisionalEventCount += 1;
      continue;
    }
    finalizedEventCount += 1;
    const delta = BigInt(event.postAmountRaw) - BigInt(event.preAmountRaw);
    balanceDeltaByAsset.set(event.asset, (balanceDeltaByAsset.get(event.asset) ?? 0n) + delta);
    totalBaseFeeLamports += BigInt(event.baseFeeLamports);
    totalPriorityFeeLamports += BigInt(event.priorityFeeLamports);
    totalJitoTipLamports += BigInt(event.jitoTipLamports);
    totalRentLamports += BigInt(event.rentLamports);
    totalFailedTransactionCostLamports += BigInt(event.failedTransactionCostLamports);
  }

  return {
    balanceDeltaByAsset: Object.fromEntries(
      [...balanceDeltaByAsset.entries()].map(([asset, amount]) => [asset, amount.toString()])
    ),
    provisionalEventCount,
    finalizedEventCount,
    totalBaseFeeLamports: totalBaseFeeLamports.toString(),
    totalPriorityFeeLamports: totalPriorityFeeLamports.toString(),
    totalJitoTipLamports: totalJitoTipLamports.toString(),
    totalRentLamports: totalRentLamports.toString(),
    totalFailedTransactionCostLamports: totalFailedTransactionCostLamports.toString()
  };
}

export const LifecycleAccountingBlockingReasonV2Schema = z.enum([
  'lifecycle_not_finalized',
  'no_finalized_events',
  'provisional_events_present',
  'rolled_back_events_present',
  'residual_asset_delta',
  'fee_attribution_partial'
]);

export const LifecycleAccountingClosureV2Schema = z.object({
  schemaVersion: z.literal(2),
  lifecycleKey: z.string().min(1),
  lifecycleStatus: z.string().min(1),
  finalizedEventCount: z.number().int().nonnegative(),
  provisionalEventCount: z.number().int().nonnegative(),
  rolledBackEventCount: z.number().int().nonnegative(),
  compensationEventCount: z.number().int().nonnegative(),
  balanceDeltaByAssetRaw: z.record(z.string(), RawIntegerStringSchema),
  residualAssetDeltas: z.array(z.object({
    asset: z.string().min(1),
    deltaRaw: RawIntegerStringSchema
  })),
  totalBaseFeeLamports: RawIntegerStringSchema,
  totalPriorityFeeLamports: RawIntegerStringSchema,
  totalJitoTipLamports: RawIntegerStringSchema,
  totalRentLamports: RawIntegerStringSchema,
  totalFailedTransactionCostLamports: RawIntegerStringSchema,
  allAssetsClosed: z.boolean(),
  formalAccountingReady: z.boolean(),
  valuationConfidence: z.enum(['exact', 'partial', 'untrusted']),
  blockingReasons: z.array(LifecycleAccountingBlockingReasonV2Schema)
});

export type LifecycleAccountingClosureV2 = z.infer<typeof LifecycleAccountingClosureV2Schema>;

export function buildLifecycleAccountingClosureV2(input: {
  lifecycleKey: string;
  lifecycleStatus: string;
  events: Array<z.input<typeof LedgerEventV2Schema>>;
  ignoredResidualAssets?: string[];
}): LifecycleAccountingClosureV2 {
  const ignoredResidualAssets = new Set(input.ignoredResidualAssets ?? []);
  const lifecycleEvents = input.events
    .map((event) => LedgerEventV2Schema.parse(event))
    .filter((event) => event.lifecycleKey === input.lifecycleKey);
  const finalizedEvents = lifecycleEvents.filter((event) => event.finality === 'finalized');
  const provisionalEventCount = lifecycleEvents.filter((event) => event.finality === 'confirmed').length;
  const rolledBackEventCount = lifecycleEvents.filter((event) => event.finality === 'rolled_back').length;
  const compensationEventCount = finalizedEvents.filter((event) => event.source === 'compensation').length;
  const partialFeeAttributionCount = finalizedEvents.filter((event) => event.feeAttribution !== 'exact').length;
  const balanceDeltaByAsset = new Map<string, bigint>();
  let totalBaseFeeLamports = 0n;
  let totalPriorityFeeLamports = 0n;
  let totalJitoTipLamports = 0n;
  let totalRentLamports = 0n;
  let totalFailedTransactionCostLamports = 0n;

  for (const event of finalizedEvents) {
    const delta = BigInt(event.postAmountRaw) - BigInt(event.preAmountRaw);
    balanceDeltaByAsset.set(event.asset, (balanceDeltaByAsset.get(event.asset) ?? 0n) + delta);
    totalBaseFeeLamports += BigInt(event.baseFeeLamports);
    totalPriorityFeeLamports += BigInt(event.priorityFeeLamports);
    totalJitoTipLamports += BigInt(event.jitoTipLamports);
    totalRentLamports += BigInt(event.rentLamports);
    totalFailedTransactionCostLamports += BigInt(event.failedTransactionCostLamports);
  }

  const balanceDeltaByAssetRaw = Object.fromEntries(
    [...balanceDeltaByAsset.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([asset, delta]) => [asset, delta.toString()])
  );
  const residualAssetDeltas = [...balanceDeltaByAsset.entries()]
    .filter(([asset, delta]) => asset !== 'SOL' && !ignoredResidualAssets.has(asset) && delta !== 0n)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([asset, delta]) => ({
      asset,
      deltaRaw: delta.toString()
    }));
  const lifecycleFinalized = input.lifecycleStatus === 'finalized_closed';
  const blockingReasons = [
    !lifecycleFinalized ? 'lifecycle_not_finalized' : undefined,
    finalizedEvents.length === 0 ? 'no_finalized_events' : undefined,
    provisionalEventCount > 0 ? 'provisional_events_present' : undefined,
    rolledBackEventCount > 0 ? 'rolled_back_events_present' : undefined,
    residualAssetDeltas.length > 0 ? 'residual_asset_delta' : undefined,
    partialFeeAttributionCount > 0 ? 'fee_attribution_partial' : undefined
  ].filter((reason): reason is z.infer<typeof LifecycleAccountingBlockingReasonV2Schema> => !!reason);
  const allAssetsClosed = residualAssetDeltas.length === 0;
  const formalAccountingReady = lifecycleFinalized
    && finalizedEvents.length > 0
    && provisionalEventCount === 0
    && rolledBackEventCount === 0
    && allAssetsClosed
    && partialFeeAttributionCount === 0;
  const valuationConfidence = formalAccountingReady
    ? 'exact' as const
    : lifecycleFinalized && finalizedEvents.length > 0 && allAssetsClosed
      ? 'partial' as const
      : 'untrusted' as const;

  return LifecycleAccountingClosureV2Schema.parse({
    schemaVersion: 2,
    lifecycleKey: input.lifecycleKey,
    lifecycleStatus: input.lifecycleStatus,
    finalizedEventCount: finalizedEvents.length,
    provisionalEventCount,
    rolledBackEventCount,
    compensationEventCount,
    balanceDeltaByAssetRaw,
    residualAssetDeltas,
    totalBaseFeeLamports: totalBaseFeeLamports.toString(),
    totalPriorityFeeLamports: totalPriorityFeeLamports.toString(),
    totalJitoTipLamports: totalJitoTipLamports.toString(),
    totalRentLamports: totalRentLamports.toString(),
    totalFailedTransactionCostLamports: totalFailedTransactionCostLamports.toString(),
    allAssetsClosed,
    formalAccountingReady,
    valuationConfidence,
    blockingReasons
  });
}

export async function buildLifecycleAccountingClosureFromLedgerStoreV2(input: {
  store: Pick<LedgerEventV2Store, 'read'>;
  lifecycleKey: string;
  lifecycleStatus: string;
  ignoredResidualAssets?: string[];
}): Promise<LifecycleAccountingClosureV2> {
  const events = await input.store.read();
  return buildLifecycleAccountingClosureV2({
    lifecycleKey: input.lifecycleKey,
    lifecycleStatus: input.lifecycleStatus,
    events,
    ignoredResidualAssets: input.ignoredResidualAssets
  });
}

export const PnlBreakdownV2InputSchema = z.object({
  principalChangeSol: z.number().finite(),
  lpFeeIncomeSol: z.number().finite(),
  inventoryPriceMoveSol: z.number().finite(),
  hodlBenchmarkSol: z.number().finite(),
  impermanentLossSol: z.number().finite(),
  baseFeeSol: z.number().finite().nonnegative(),
  priorityFeeSol: z.number().finite().nonnegative(),
  jitoTipSol: z.number().finite().nonnegative(),
  rentSol: z.number().finite(),
  failedTransactionCostSol: z.number().finite().nonnegative(),
  residualLiquidationImpactSol: z.number().finite(),
  allAssetsClosed: z.boolean(),
  finalized: z.boolean(),
  reconciliationDeltaLamports: RawIntegerStringSchema
});

function roundSol(value: number) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

export function buildPnlBreakdownV2(input: z.input<typeof PnlBreakdownV2InputSchema>) {
  const parsed = PnlBreakdownV2InputSchema.parse(input);
  const grossPnlSol = roundSol(
    parsed.principalChangeSol + parsed.lpFeeIncomeSol + parsed.inventoryPriceMoveSol
  );
  const chainCosts = parsed.baseFeeSol
    + parsed.priorityFeeSol
    + parsed.jitoTipSol
    + parsed.rentSol
    + parsed.failedTransactionCostSol;
  const netPnlSol = roundSol(grossPnlSol - chainCosts + parsed.residualLiquidationImpactSol);
  const fullyReconciled = parsed.finalized
    && parsed.allAssetsClosed
    && BigInt(parsed.reconciliationDeltaLamports) === 0n;
  const valuationConfidence = fullyReconciled
    ? 'exact' as const
    : parsed.finalized && BigInt(parsed.reconciliationDeltaLamports) === 0n
      ? 'partial' as const
      : 'untrusted' as const;

  return {
    ...parsed,
    grossPnlSol,
    netPnlSol,
    valuationConfidence
  };
}
