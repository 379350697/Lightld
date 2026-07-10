import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LedgerEventV2Store } from '../../../src/runtime/ledger-event-v2';
import { appendLedgerEventsFromTransactionMeta } from '../../../src/runtime/transaction-meta-ledger-v2';

describe('appendLedgerEventsFromTransactionMeta', () => {
  it('attributes SOL and token fills from one transaction meta without using a wallet-wide delta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-meta-ledger-'));
    const store = new LedgerEventV2Store(root);
    const events = await appendLedgerEventsFromTransactionMeta({
      store,
      lifecycleKey: 'lifecycle-1',
      signature: 'signature-1',
      finality: 'finalized',
      walletAddress: 'wallet-1',
      transaction: {
        slot: 101,
        blockTime: 1_784_534_400,
        transaction: {
          message: { accountKeys: [{ pubkey: 'wallet-1' }, { pubkey: 'token-account-1' }] }
        },
        meta: {
          fee: 5_000,
          preBalances: [1_000_000_000, 0],
          postBalances: [989_995_000, 0],
          preTokenBalances: [{ accountIndex: 1, mint: 'mint-1', owner: 'wallet-1', uiTokenAmount: { amount: '0' } }],
          postTokenBalances: [{ accountIndex: 1, mint: 'mint-1', owner: 'wallet-1', uiTokenAmount: { amount: '2500000' } }]
        }
      }
    });

    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: 'SOL', preAmountRaw: '1000000000', postAmountRaw: '989995000', baseFeeLamports: '5000' }),
      expect.objectContaining({ asset: 'mint-1', preAmountRaw: '0', postAmountRaw: '2500000', baseFeeLamports: '0' })
    ]));
    expect(await store.read()).toHaveLength(2);
  });

  it('rejects finalized accounting when transaction meta is absent or token ownership is ambiguous', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-meta-ledger-bad-'));
    const store = new LedgerEventV2Store(root);

    await expect(appendLedgerEventsFromTransactionMeta({
      store,
      lifecycleKey: 'lifecycle-1',
      signature: 'signature-1',
      finality: 'finalized',
      walletAddress: 'wallet-1',
      transaction: { slot: 101, transaction: { message: { accountKeys: [] } }, meta: null }
    })).rejects.toThrow(/transaction meta is unavailable/);
  });
});
