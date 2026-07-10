import { join } from 'node:path';

import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from '../runtime/atomic-file.ts';
import {
  buildProfessionalQuoteCommitment,
  type ProfessionalQuoteEvidence
} from '../runtime/professional-order-intent.ts';
import { computeIntentQuoteHash } from './live-order-intent-schema.ts';

export const ExecutionQuoteEvidenceV2Schema = z.object({
  action: z.enum(['buy', 'sell', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']),
  poolAddress: z.string(),
  tokenMint: z.string(),
  requestedPositionSol: z.number().finite().positive(),
  chainPositionAddress: z.string().min(1).optional(),
  routeExists: z.boolean(),
  outputSol: z.number().finite().nonnegative(),
  slippageBps: z.number().finite().nonnegative(),
  quotedAt: z.string().datetime({ offset: true }),
  quoteSlot: z.number().int().nonnegative(),
  impactBps: z.number().finite().nonnegative(),
  estimatedTotalFeeLamports: z.number().int().nonnegative(),
  maxTotalFeeLamports: z.number().int().nonnegative(),
  lastValidBlockHeight: z.number().int().nonnegative(),
  expiresAt: z.string().datetime({ offset: true }),
  quoteHash: z.string().regex(/^[a-f0-9]{64}$/)
});

export type ExecutionQuoteEvidenceV2 = z.infer<typeof ExecutionQuoteEvidenceV2Schema>;

const SnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  quotes: ExecutionQuoteEvidenceV2Schema.array()
});

export function verifyExecutionQuoteEvidenceV2(input: ExecutionQuoteEvidenceV2) {
  const quote = ExecutionQuoteEvidenceV2Schema.parse(input);
  const expectedHash = computeIntentQuoteHash(
    buildProfessionalQuoteCommitment(quote satisfies Omit<ProfessionalQuoteEvidence, 'stale'>)
  );
  if (quote.quoteHash !== expectedHash) {
    throw new Error('execution quote evidence hash does not match its immutable payload');
  }
  if (Date.parse(quote.expiresAt) <= Date.parse(quote.quotedAt)) {
    throw new Error('execution quote evidence expiry must be later than quote timestamp');
  }
  return quote;
}

export class ExecutionQuoteEvidenceStoreV2 {
  private readonly path: string;

  constructor(stateRootDir: string) {
    this.path = join(stateRootDir, 'execution-quote-evidence-v2.json');
  }

  async record(input: ExecutionQuoteEvidenceV2) {
    const quote = verifyExecutionQuoteEvidenceV2(input);
    const snapshot = (await readJsonIfExists(this.path, SnapshotSchema)) ?? {
      schemaVersion: 2 as const,
      quotes: []
    };
    const existing = snapshot.quotes.find((entry) => entry.quoteHash === quote.quoteHash);
    if (existing) {
      verifyExecutionQuoteEvidenceV2(existing);
      if (JSON.stringify(existing) !== JSON.stringify(quote)) {
        throw new Error(`execution quote hash conflict quoteHash=${quote.quoteHash}`);
      }
      return existing;
    }
    const now = Date.now();
    const retained = snapshot.quotes.filter((entry) => Date.parse(entry.expiresAt) >= now - 60_000);
    retained.push(quote);
    await writeJsonAtomically(this.path, SnapshotSchema.parse({ schemaVersion: 2, quotes: retained }));
    return quote;
  }

  async read(quoteHash: string) {
    const snapshot = await readJsonIfExists(this.path, SnapshotSchema);
    return snapshot?.quotes.find((entry) => entry.quoteHash === quoteHash) ?? null;
  }
}
