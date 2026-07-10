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

export function buildFinalizedLedgerProjection(events: LedgerEventV2[]) {
  const balanceDeltaByAsset = new Map<string, bigint>();
  let provisionalEventCount = 0;
  let finalizedEventCount = 0;
  let totalBaseFeeLamports = 0n;
  let totalPriorityFeeLamports = 0n;
  let totalJitoTipLamports = 0n;
  let totalRentLamports = 0n;

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
    totalRentLamports: totalRentLamports.toString()
  };
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
