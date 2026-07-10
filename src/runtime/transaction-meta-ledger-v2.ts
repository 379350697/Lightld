import type { LedgerEventV2 } from './ledger-event-v2.ts';
import { LedgerEventV2Store } from './ledger-event-v2.ts';

type RpcTokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
};

type RpcTransactionMeta = {
  err?: unknown;
  fee?: number;
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: RpcTokenBalance[];
  postTokenBalances?: RpcTokenBalance[];
};

type RpcTransaction = {
  slot?: number;
  blockTime?: number | null;
  transaction?: {
    message?: {
      accountKeys?: Array<{ pubkey?: string } | string>;
    };
  };
  meta?: RpcTransactionMeta | null;
};

function rawAmount(balance: RpcTokenBalance | undefined) {
  const amount = balance?.uiTokenAmount?.amount;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return '0';
  return amount;
}

function accountKey(keys: Array<{ pubkey?: string } | string>, index: number) {
  const entry = keys[index];
  return typeof entry === 'string' ? entry : entry?.pubkey ?? `account-index:${index}`;
}

function accountChangeFromRaw(pre: string | number | bigint | undefined, post: string | number | bigint | undefined) {
  const preBig = BigInt(String(pre ?? '0'));
  const postBig = BigInt(String(post ?? '0'));
  if (preBig === 0n && postBig > 0n) return 'created' as const;
  if (preBig > 0n && postBig === 0n) return 'closed' as const;
  return 'unchanged' as const;
}

function tokenAccountChange(pre: RpcTokenBalance | undefined, post: RpcTokenBalance | undefined) {
  if (!pre && post) return 'created' as const;
  if (pre && !post) return 'closed' as const;
  return accountChangeFromRaw(rawAmount(pre), rawAmount(post));
}

/**
 * Emits transaction-scoped accounting events. It intentionally refuses to
 * infer a fill from a wallet snapshot: every delta comes from the supplied
 * transaction meta and can therefore coexist with concurrent transactions.
 */
export async function appendLedgerEventsFromTransactionMeta(input: {
  store: LedgerEventV2Store;
  lifecycleKey: string;
  signature: string;
  finality: 'confirmed' | 'finalized';
  walletAddress: string;
  transaction: RpcTransaction | null;
}): Promise<LedgerEventV2[]> {
  const transaction = input.transaction;
  if (!transaction?.meta) {
    throw new Error(`transaction meta is unavailable signature=${input.signature}`);
  }
  const meta = transaction.meta;
  const keys = transaction.transaction?.message?.accountKeys ?? [];
  const walletIndex = keys.findIndex((entry) => accountKey(keys, keys.indexOf(entry)) === input.walletAddress);
  if (walletIndex < 0 || meta.preBalances?.[walletIndex] === undefined || meta.postBalances?.[walletIndex] === undefined) {
    throw new Error(`wallet balance meta is unavailable signature=${input.signature}`);
  }
  const slot = transaction.slot;
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) {
    throw new Error(`transaction slot is unavailable signature=${input.signature}`);
  }
  const blockTime = typeof transaction.blockTime === 'number'
    ? new Date(transaction.blockTime * 1000).toISOString()
    : new Date(0).toISOString();
  const transactionStatus = meta.err ? 'failed' as const : 'succeeded' as const;
  const events: Array<Omit<LedgerEventV2, 'eventId'>> = [{
    lifecycleKey: input.lifecycleKey,
    signature: input.signature,
    instructionIndex: 0,
    account: input.walletAddress,
    asset: 'SOL',
    mint: 'SOL',
    slot,
    blockTime,
    finality: input.finality,
    preAmountRaw: String(meta.preBalances[walletIndex]),
    postAmountRaw: String(meta.postBalances[walletIndex]),
    baseFeeLamports: String(meta.fee ?? 0),
    priorityFeeLamports: '0',
    jitoTipLamports: '0',
    rentLamports: '0',
    failedTransactionCostLamports: transactionStatus === 'failed' ? String(meta.fee ?? 0) : '0',
    accountChange: accountChangeFromRaw(meta.preBalances[walletIndex], meta.postBalances[walletIndex]),
    transactionStatus,
    source: 'transaction-meta'
  }];
  const preByAccountMint = new Map<string, RpcTokenBalance>();
  const postByAccountMint = new Map<string, RpcTokenBalance>();
  for (const balance of meta.preTokenBalances ?? []) {
    preByAccountMint.set(`${balance.accountIndex}:${balance.mint}`, balance);
  }
  for (const balance of meta.postTokenBalances ?? []) {
    postByAccountMint.set(`${balance.accountIndex}:${balance.mint}`, balance);
  }
  const tokenKeys = new Set([...preByAccountMint.keys(), ...postByAccountMint.keys()]);
  for (const key of [...tokenKeys].sort()) {
    const pre = preByAccountMint.get(key);
    const post = postByAccountMint.get(key);
    const owner = post?.owner ?? pre?.owner;
    if (owner !== input.walletAddress) continue;
    const accountIndex = post?.accountIndex ?? pre?.accountIndex;
    const mint = post?.mint ?? pre?.mint;
    if (accountIndex === undefined || !mint) continue;
    events.push({
      lifecycleKey: input.lifecycleKey,
      signature: input.signature,
      instructionIndex: 0,
      account: accountKey(keys, accountIndex),
      asset: mint,
      mint,
      slot,
      blockTime,
      finality: input.finality,
      preAmountRaw: rawAmount(pre),
      postAmountRaw: rawAmount(post),
      baseFeeLamports: '0',
      priorityFeeLamports: '0',
      jitoTipLamports: '0',
      rentLamports: '0',
      failedTransactionCostLamports: '0',
      accountChange: tokenAccountChange(pre, post),
      transactionStatus,
      source: 'transaction-meta'
    });
  }
  return Promise.all(events.map((event) => input.store.append(event)));
}
