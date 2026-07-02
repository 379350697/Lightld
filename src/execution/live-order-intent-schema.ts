import { z } from 'zod';

export const LiveOrderIntentSchema = z.object({
  strategyId: z.string().min(1),
  poolAddress: z.string().min(1),
  outputSol: z.number().finite().positive(),
  createdAt: z.string().min(1),
  idempotencyKey: z.string().min(1),
  side: z.enum(['buy', 'sell', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']).default('buy'),
  tokenMint: z.string().default(''),
  fullPositionExit: z.boolean().default(false),
  liquidateResidualTokenToSol: z.boolean().default(false),
  openIntentId: z.string().min(1).optional(),
  positionId: z.string().min(1).optional(),
  chainPositionAddress: z.string().min(1).optional()
});

export type LiveOrderIntent = z.infer<typeof LiveOrderIntentSchema>;
