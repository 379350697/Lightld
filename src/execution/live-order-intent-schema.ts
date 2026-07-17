import { z } from 'zod';

const ExecutionPolicySchema = z.enum(['broadcast', 'simulate-only']);
const LiveOrderIntentShape = {
  strategyId: z.string().min(1),
  // A sell can intentionally be routed without pinning a pool (Jupiter/OKX
  // select the executable route). Every pool-bound action still requires the
  // exact pool identity.
  poolAddress: z.string(),
  outputSol: z.number().finite().positive(),
  createdAt: z.string().min(1),
  idempotencyKey: z.string().min(1),
  executionPolicy: ExecutionPolicySchema,
  side: z.enum(['buy', 'sell', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']).default('buy'),
  tokenMint: z.string().default(''),
  fullPositionExit: z.boolean().default(false),
  liquidateResidualTokenToSol: z.boolean().default(false),
  maxSlippageBps: z.number().int().nonnegative().optional(),
  maxImpactBps: z.number().int().nonnegative().optional(),
  inputAmountRaw: z.string().regex(/^\d+$/).refine((value) => BigInt(value) > 0n).optional(),
  preEntryTokenAmountRaw: z.string().regex(/^\d+$/).optional(),
  preEntryWalletSol: z.number().finite().nonnegative().optional(),
  preExitTokenAmountRaw: z.string().regex(/^\d+$/).optional(),
  openIntentId: z.string().min(1).optional(),
  positionId: z.string().min(1).optional(),
  chainPositionAddress: z.string().min(1).optional()
};

function validatePoolIdentity(
  intent: { side: string; poolAddress: string },
  context: z.RefinementCtx
) {
  if (intent.side !== 'sell' && intent.poolAddress.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['poolAddress'],
      message: `poolAddress is required for ${intent.side}`
    });
  }
}

export const LiveOrderIntentSchema = z.object(LiveOrderIntentShape).superRefine(validatePoolIdentity);

// On-disk execution journals written before executionPolicy became mandatory
// remain readable. Network requests still use LiveOrderIntentSchema and must
// explicitly carry the signed policy.
export const PersistedLiveOrderIntentSchema = z.object({
  ...LiveOrderIntentShape,
  executionPolicy: ExecutionPolicySchema.default('broadcast')
}).superRefine(validatePoolIdentity);

export type LiveOrderIntent = z.infer<typeof LiveOrderIntentSchema>;
