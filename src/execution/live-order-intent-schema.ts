import { createHash } from 'node:crypto';

import { z } from 'zod';

import { stableStringify } from '../shared/canonical-json.ts';

export const ExecutionModeSchema = z.enum([
  'mechanical-soak',
  'economic-shadow',
  'canary',
  'live'
]);

export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

const OrderSideSchema = z.enum([
  'buy',
  'sell',
  'add-lp',
  'withdraw-lp',
  'claim-fee',
  'rebalance-lp'
]);

const LegacyLiveOrderIntentSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  strategyId: z.string().min(1),
  poolAddress: z.string().min(1),
  outputSol: z.number().finite().positive(),
  createdAt: z.string().min(1),
  idempotencyKey: z.string().min(1),
  side: OrderSideSchema.default('buy'),
  tokenMint: z.string().default(''),
  fullPositionExit: z.boolean().default(false),
  liquidateResidualTokenToSol: z.boolean().default(false),
  openIntentId: z.string().min(1).optional(),
  positionId: z.string().min(1).optional(),
  chainPositionAddress: z.string().min(1).optional()
});

const LiveOrderIntentV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  strategyId: z.string().min(1),
  poolAddress: z.string().min(1),
  tokenMint: z.string().min(1),
  outputSol: z.number().finite().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z.string().min(1),
  side: OrderSideSchema,
  fullPositionExit: z.boolean().default(false),
  liquidateResidualTokenToSol: z.boolean().default(false),

  runId: z.string().min(1),
  lifecycleKey: z.string().min(1),
  openIntentId: z.string().min(1),
  positionId: z.string().min(1).optional(),
  chainPositionAddress: z.string().min(1).optional(),
  configSnapshotId: z.string().min(1),
  riskSnapshotId: z.string().min(1),

  maxInputSol: z.number().finite().positive().optional(),
  minOutputSol: z.number().finite().positive().optional(),
  maxSlippageBps: z.number().int().nonnegative(),
  maxImpactBps: z.number().int().nonnegative(),
  quotedImpactBps: z.number().finite().nonnegative(),
  maxTotalFeeLamports: z.number().int().nonnegative(),
  estimatedTotalFeeLamports: z.number().int().nonnegative(),
  quoteHash: z.string().regex(/^[a-f0-9]{64}$/, 'quoteHash must be a lowercase SHA-256 digest'),
  quoteSlot: z.number().int().nonnegative(),
  quoteCreatedAt: z.iso.datetime({ offset: true }),
  candidateObservedAt: z.iso.datetime({ offset: true }).optional(),
  expiresAt: z.iso.datetime({ offset: true }),
  lastValidBlockHeight: z.number().int().nonnegative()
}).superRefine((intent, context) => {
  const riskIncreasing = intent.side === 'buy'
    || intent.side === 'add-lp'
    || intent.side === 'rebalance-lp';
  const exitWithProceeds = intent.side === 'sell' || intent.side === 'withdraw-lp';

  if (riskIncreasing && intent.maxInputSol === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['maxInputSol'],
      message: `maxInputSol is required for ${intent.side}`
    });
  }

  if (riskIncreasing && intent.maxInputSol !== undefined && intent.outputSol > intent.maxInputSol) {
    context.addIssue({
      code: 'custom',
      path: ['maxInputSol'],
      message: `maxInputSol must cover outputSol for ${intent.side}`
    });
  }

  if (riskIncreasing && intent.candidateObservedAt === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['candidateObservedAt'],
      message: `candidateObservedAt is required for ${intent.side}`
    });
  }

  if (exitWithProceeds && intent.minOutputSol === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['minOutputSol'],
      message: `minOutputSol is required for ${intent.side}`
    });
  }

  if (exitWithProceeds && intent.positionId === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['positionId'],
      message: `positionId is required for ${intent.side}`
    });
  }

  if (exitWithProceeds && intent.chainPositionAddress === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['chainPositionAddress'],
      message: `chainPositionAddress is required for ${intent.side}`
    });
  }

  if (intent.quotedImpactBps > intent.maxImpactBps) {
    context.addIssue({
      code: 'custom',
      path: ['quotedImpactBps'],
      message: `quotedImpactBps ${intent.quotedImpactBps} exceeds maxImpactBps ${intent.maxImpactBps}`
    });
  }

  if (intent.estimatedTotalFeeLamports > intent.maxTotalFeeLamports) {
    context.addIssue({
      code: 'custom',
      path: ['estimatedTotalFeeLamports'],
      message: `estimatedTotalFeeLamports ${intent.estimatedTotalFeeLamports} exceeds maxTotalFeeLamports ${intent.maxTotalFeeLamports}`
    });
  }

  if (Date.parse(intent.expiresAt) <= Date.parse(intent.createdAt)) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'expiresAt must be later than createdAt'
    });
  }
});

export const LiveOrderIntentV2Schema = LiveOrderIntentV2BaseSchema;
export const LiveOrderIntentSchema = z.union([
  LiveOrderIntentV2Schema,
  LegacyLiveOrderIntentSchema
]);

export type LegacyLiveOrderIntent = z.infer<typeof LegacyLiveOrderIntentSchema>;
export type LiveOrderIntentV2 = z.infer<typeof LiveOrderIntentV2Schema>;
export type LiveOrderIntent = z.infer<typeof LiveOrderIntentSchema>;

export function computeIntentQuoteHash(quotePayload: unknown) {
  return createHash('sha256')
    .update(stableStringify(quotePayload))
    .digest('hex');
}

export const ObservedIntentExecutionSchema = z.object({
  actualInputSol: z.number().finite().nonnegative().optional(),
  actualOutputSol: z.number().finite().nonnegative().optional(),
  actualSlippageBps: z.number().finite().nonnegative(),
  actualImpactBps: z.number().finite().nonnegative(),
  actualTotalFeeLamports: z.number().int().nonnegative(),
  actualQuoteHash: z.string().regex(/^[a-f0-9]{64}$/)
});

export type ObservedIntentExecution = z.infer<typeof ObservedIntentExecutionSchema>;

/** Rechecks values observed during build/simulation before any broadcast. */
export function validateIntentExecutionEnvelope(
  intent: LiveOrderIntentV2,
  observed: ObservedIntentExecution
) {
  const validated = ObservedIntentExecutionSchema.parse(observed);

  if (intent.maxInputSol !== undefined && validated.actualInputSol === undefined) {
    throw new Error('actualInputSol is required to enforce signed maxInputSol');
  }

  if (intent.maxInputSol !== undefined
    && validated.actualInputSol !== undefined
    && validated.actualInputSol > intent.maxInputSol) {
    throw new Error(`actualInputSol exceeds signed maxInputSol ${intent.maxInputSol}`);
  }

  if (intent.minOutputSol !== undefined && validated.actualOutputSol === undefined) {
    throw new Error('actualOutputSol is required to enforce signed minOutputSol');
  }

  if (intent.minOutputSol !== undefined
    && validated.actualOutputSol !== undefined
    && validated.actualOutputSol < intent.minOutputSol) {
    throw new Error(`actualOutputSol is below signed minOutputSol ${intent.minOutputSol}`);
  }

  if (validated.actualSlippageBps > intent.maxSlippageBps) {
    throw new Error(`actualSlippageBps exceeds signed maxSlippageBps ${intent.maxSlippageBps}`);
  }

  if (validated.actualImpactBps > intent.maxImpactBps) {
    throw new Error(`actualImpactBps exceeds signed maxImpactBps ${intent.maxImpactBps}`);
  }

  if (validated.actualTotalFeeLamports > intent.maxTotalFeeLamports) {
    throw new Error(`actualTotalFeeLamports exceeds signed maxTotalFeeLamports ${intent.maxTotalFeeLamports}`);
  }

  if (validated.actualQuoteHash !== intent.quoteHash) {
    throw new Error('actualQuoteHash does not match signed quoteHash');
  }

  return validated;
}

export type IntentBoundaryOptions = {
  mode: ExecutionMode;
  stage: 'sign' | 'broadcast';
  now?: string | Date;
  currentBlockHeight?: number;
  maxCandidateAgeMs?: number;
  maxQuoteAgeAtSignMs?: number;
  maxQuoteAgeAtBroadcastMs?: number;
};

function timestampMs(value: string | Date, field: string) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} is not a valid timestamp`);
  }

  return parsed;
}

function assertFreshTimestamp(
  timestamp: string,
  nowMs: number,
  maxAgeMs: number,
  label: string
) {
  const observedAtMs = timestampMs(timestamp, label);
  const ageMs = nowMs - observedAtMs;

  if (ageMs < -1_000) {
    throw new Error(`${label} timestamp is in the future`);
  }

  if (ageMs > maxAgeMs) {
    throw new Error(`${label} is stale: age ${ageMs}ms exceeds ${maxAgeMs}ms`);
  }
}

/**
 * Validates an intent at the signer or broadcaster trust boundary. V1 is
 * deliberately accepted only by an explicitly selected mechanical-soak
 * process; production-like modes are V2-only and fail closed.
 */
export function validateLiveOrderIntentBoundary(
  rawIntent: unknown,
  options: IntentBoundaryOptions
): (LiveOrderIntentV2 & { schemaVersion: 2 }) | (LegacyLiveOrderIntent & { schemaVersion: 1 }) {
  const parsed = LiveOrderIntentSchema.parse(rawIntent);

  if (parsed.schemaVersion !== 2) {
    if (options.mode !== 'mechanical-soak') {
      throw new Error('V1 intents are allowed only in explicit mechanical-soak mode');
    }

    return {
      ...parsed,
      schemaVersion: 1
    };
  }

  const nowMs = timestampMs(options.now ?? new Date(), 'now');
  const riskIncreasing = parsed.side === 'buy'
    || parsed.side === 'add-lp'
    || parsed.side === 'rebalance-lp';

  if (timestampMs(parsed.expiresAt, 'expiresAt') <= nowMs) {
    throw new Error('intent expired');
  }

  if (riskIncreasing) {
    assertFreshTimestamp(
      parsed.candidateObservedAt!,
      nowMs,
      options.maxCandidateAgeMs ?? 15_000,
      'candidate'
    );
  }

  assertFreshTimestamp(
    parsed.quoteCreatedAt,
    nowMs,
    options.stage === 'sign'
      ? options.maxQuoteAgeAtSignMs ?? 2_000
      : options.maxQuoteAgeAtBroadcastMs ?? 3_000,
    'quote'
  );

  if (options.stage === 'broadcast' && options.mode !== 'mechanical-soak') {
    if (options.currentBlockHeight === undefined) {
      throw new Error('current block height is unavailable; refusing broadcast');
    }

    if (options.currentBlockHeight > parsed.lastValidBlockHeight) {
      throw new Error(
        `block height expired: current ${options.currentBlockHeight} exceeds last valid ${parsed.lastValidBlockHeight}`
      );
    }
  }

  return parsed;
}
