import { z } from 'zod';

const UrlArraySchema = z.array(z.string().url()).min(1);

export const BroadcastPolicyV2Schema = z.discriminatedUnion('kind', [
  z.object({
    schemaVersion: z.literal(2),
    kind: z.literal('standard_rpc_fanout'),
    writeRpcUrls: UrlArraySchema,
    privateFlow: z.literal(false),
    jitoBundle: z.literal(false)
  }),
  z.object({
    schemaVersion: z.literal(2),
    kind: z.literal('staked_private_rpc'),
    privateRpcUrls: UrlArraySchema,
    privateFlow: z.literal(true),
    jitoBundle: z.literal(false)
  }),
  z.object({
    schemaVersion: z.literal(2),
    kind: z.literal('jito_bundle'),
    blockEngineUrl: z.string().url(),
    privateFlow: z.literal(true),
    jitoBundle: z.literal(true)
  })
]);

export type BroadcastPolicyV2 = z.infer<typeof BroadcastPolicyV2Schema>;

export function buildBroadcastPolicyV2(input: {
  kind?: BroadcastPolicyV2['kind'];
  writeRpcUrls: string[];
  privateRpcUrls?: string[];
  blockEngineUrl?: string;
}): BroadcastPolicyV2 {
  const kind = input.kind ?? 'standard_rpc_fanout';

  if (kind === 'staked_private_rpc') {
    return BroadcastPolicyV2Schema.parse({
      schemaVersion: 2,
      kind,
      privateRpcUrls: input.privateRpcUrls ?? input.writeRpcUrls,
      privateFlow: true,
      jitoBundle: false
    });
  }

  if (kind === 'jito_bundle') {
    return BroadcastPolicyV2Schema.parse({
      schemaVersion: 2,
      kind,
      blockEngineUrl: input.blockEngineUrl,
      privateFlow: true,
      jitoBundle: true
    });
  }

  return BroadcastPolicyV2Schema.parse({
    schemaVersion: 2,
    kind: 'standard_rpc_fanout',
    writeRpcUrls: input.writeRpcUrls,
    privateFlow: false,
    jitoBundle: false
  });
}

export function validateBroadcastPolicyForFees(input: {
  policy: BroadcastPolicyV2;
  jitoTipLamports?: number;
}) {
  const policy = BroadcastPolicyV2Schema.parse(input.policy);
  const jitoTipLamports = input.jitoTipLamports ?? 0;

  if (!Number.isInteger(jitoTipLamports) || jitoTipLamports < 0) {
    throw new Error('jitoTipLamports must be a nonnegative integer.');
  }

  if (jitoTipLamports > 0 && !policy.privateFlow) {
    throw new Error('Jito tip requires a private RPC or Jito bundle broadcast policy; refusing standard RPC fanout.');
  }

  return policy;
}
